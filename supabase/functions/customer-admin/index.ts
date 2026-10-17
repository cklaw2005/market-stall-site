import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function phoneValue(value: unknown): string {
  let valueText = String(value ?? "").trim().replace(/[\s()-]/g, "");
  if (/^0\d{8,11}$/.test(valueText)) valueText = `+60${valueText.slice(1)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(valueText)) throw new Error("请输入含国家区号的有效手机号，例如 +60123456789。");
  return valueText;
}

function loginEmailForPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@login.market-stall.invalid`;
}

function temporaryPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Please sign in." }, 401);

  const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData.user) return json({ error: "Session expired. Sign in again." }, 401);

  try {
    const input = await request.json();
    const action = String(input.action ?? "");
    const callerId = callerData.user.id;

    if (action === "change_own_password") {
      const password = String(input.new_password ?? "");
      if (password.length < 10 || password.length > 128) throw new Error("新密码必须为 10 至 128 个字符。");
      const { data: profile } = await admin.from("profiles").select("active,must_change_password").eq("user_id", callerId).maybeSingle();
      if (!profile?.active) throw new Error("账号已停用。");
      const { error: passwordError } = await admin.auth.admin.updateUserById(callerId, { password });
      if (passwordError) throw passwordError;
      const { error: profileError } = await admin.from("profiles").update({ must_change_password: false }).eq("user_id", callerId);
      if (profileError) throw profileError;
      return json({ ok: true });
    }

    const restaurantId = String(input.restaurant_id ?? "");
    const { data: membership } = await admin.from("restaurant_memberships").select("role").eq("restaurant_id", restaurantId).eq("user_id", callerId).maybeSingle();
    if (!membership || !["owner", "manager"].includes(membership.role)) return json({ error: "Not authorized for this stall." }, 403);

    if (action === "create") {
      const displayName = String(input.display_name ?? "").trim().slice(0, 100);
      const phone = phoneValue(input.phone);
      const keys = [...new Set((Array.isArray(input.preferred_product_keys) ? input.preferred_product_keys : []).map(String))].slice(0, 100);
      if (!displayName) throw new Error("请填写顾客姓名。");
      if (keys.length > 10) throw new Error("每位顾客最多选择 10 项常买偏好。");
      if (keys.length) {
        const { data: menuRows, error: menuError } = await admin.from("menu_items").select("product_key").eq("restaurant_id", restaurantId).eq("active", true).in("product_key", keys);
        if (menuError) throw menuError;
        if ((menuRows ?? []).length !== keys.length) throw new Error("偏好商品中有不属于此摊位的项目，请重新选择。");
      }
      const { data: activeCustomers, error: slotsError } = await admin.from("profiles").select("customer_slot").eq("restaurant_id", restaurantId).eq("role", "customer");
      if (slotsError) throw slotsError;
      const slot = Math.max(0, ...(activeCustomers ?? []).map((row) => Number(row.customer_slot) || 0)) + 1;
      const temp = temporaryPassword();
      const { data: created, error: createError } = await admin.auth.admin.createUser({ email: loginEmailForPhone(phone), password: temp, email_confirm: true, user_metadata: { display_name: displayName, phone } });
      if (createError) throw createError;
      const { error: profileError } = await admin.from("profiles").insert({ user_id: created.user.id, display_name: displayName, phone, restaurant_id: restaurantId, role: "customer", customer_slot: slot, preferred_product_keys: keys, active: true, must_change_password: true });
      if (profileError) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw profileError;
      }
      return json({ ok: true, slot, temporary_password: temp });
    }

    const customerId = String(input.customer_id ?? "");
    const { data: customer, error: customerError } = await admin.from("profiles").select("user_id,active,role,restaurant_id").eq("user_id", customerId).maybeSingle();
    if (customerError || !customer || customer.role !== "customer" || customer.restaurant_id !== restaurantId) return json({ error: "顾客账号不存在或不属于此摊位。" }, 404);

    if (action === "set_preferences") {
      const keys = [...new Set((Array.isArray(input.preferred_product_keys) ? input.preferred_product_keys : []).map(String))];
      if (keys.length > 10) throw new Error("每位顾客最多选择 10 项常买偏好。");
      if (keys.length) {
        const { data: menuRows, error: menuError } = await admin.from("menu_items").select("product_key").eq("restaurant_id", restaurantId).eq("active", true).in("product_key", keys);
        if (menuError) throw menuError;
        if ((menuRows ?? []).length !== keys.length) throw new Error("偏好商品中有不属于此摊位的项目，请重新选择。");
      }
      const { error } = await admin.from("profiles").update({ preferred_product_keys: keys }).eq("user_id", customerId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "reset") {
      if (!customer.active) throw new Error("此账号已停用。");
      const temp = temporaryPassword();
      const { error } = await admin.auth.admin.updateUserById(customerId, { password: temp });
      if (error) throw error;
      const { error: profileError } = await admin.from("profiles").update({ must_change_password: true }).eq("user_id", customerId);
      if (profileError) throw profileError;
      return json({ ok: true, temporary_password: temp });
    }

    if (action === "deactivate") {
      if (!customer.active) return json({ ok: true });
      const { error } = await admin.from("profiles").update({ active: false }).eq("user_id", customerId);
      if (error) throw error;
      const { error: authError } = await admin.auth.admin.updateUserById(customerId, { ban_duration: "876000h" });
      if (authError) throw authError;
      return json({ ok: true });
    }
    if (action === "reactivate") {
      if (customer.active) throw new Error("此账号已启用。");
      const { data: activeCustomers, error: slotsError } = await admin.from("profiles").select("customer_slot").eq("restaurant_id", restaurantId).eq("role", "customer");
      if (slotsError) throw slotsError;
      const slot = Math.max(0, ...(activeCustomers ?? []).map((row) => Number(row.customer_slot) || 0)) + 1;
      const temp = temporaryPassword();
      const { error: authError } = await admin.auth.admin.updateUserById(customerId, { password: temp, ban_duration: "none" });
      if (authError) throw authError;
      const { error } = await admin.from("profiles").update({ active: true, customer_slot: slot, must_change_password: true }).eq("user_id", customerId);
      if (error) throw error;
      return json({ ok: true, slot, temporary_password: temp });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed." }, 400);
  }
});

