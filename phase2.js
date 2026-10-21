import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $ = (selector) => document.querySelector(selector);
const config = window.SUPABASE_CONFIG;
const FETCH_TIMEOUT_MS = 20000;
const setupWarning = $('#setup-warning');
const authCard = $('#auth-card');
const appArea = $('#app-area');
const authStatus = $('#auth-status');
let supabase = null;
let user = null;
let restaurant = null;
let accountProfile = null;
let ownerMode = false;
let catalog = [];
let preferredProductKeys = [];
const selected = new Map();
const restaurantSlug = new URLSearchParams(location.search).get('restaurant') || config?.restaurantSlug || 'dad-vegetable-stall';
const money = (value) => `RM ${Number(value || 0).toFixed(2)}`;
const isWeightUnit = (unit) => ['公斤', 'kg', 'KG'].includes(String(unit || ''));
const formatKgFromGrams = (grams) => (Number(grams || 0) / 1000).toFixed(3).replace(/\.?0+$/, '');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const productEnglishName = (product) => String(product?.name_en || window.PRODUCT_EN_NAMES?.[product?.product_key] || '').trim();

function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), FETCH_TIMEOUT_MS);
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', () => controller.abort(init.signal.reason), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

if (!config?.url || !config?.anonKey || config.url.includes('YOUR-PROJECT') || config.anonKey.includes('YOUR-SUPABASE')) {
  setupWarning.classList.remove('hidden');
  authCard.classList.add('hidden');
} else {
  supabase = createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, global: { fetch: fetchWithTimeout } });
}

$('#password-sign-in').addEventListener('click', async () => {
  if (!supabase) return;
  const button = $('#password-sign-in'); button.disabled = true;
  authStatus.textContent = '正在登录…';
  const phone = normalizePhone($('#phone').value);
  const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmailForPhone(phone), password: $('#password').value });
  button.disabled = false;
  if (error) { authStatus.textContent = `登录失败：${error.message}`; return; }
  user = data.user; await openApp();
});

$('#change-first-password').addEventListener('click', async () => {
  const a = $('#new-password').value, b = $('#new-password-repeat').value, status = $('#password-status');
  if (a.length < 10) { status.textContent = '密码至少需要 10 个字符。'; return; }
  if (a !== b) { status.textContent = '两次输入的密码不一致。'; return; }
  const { error } = await supabase.functions.invoke('customer-admin', { body: { action: 'change_own_password', new_password: a } });
  if (error) { status.textContent = `密码更新失败：${error.message}`; return; }
  status.textContent = '密码已更新，正在进入订单页面…'; await openApp();
});

$('#sign-out').addEventListener('click', async () => { await supabase.auth.signOut(); location.reload(); });

async function openApp() {
  if (!supabase || !user) return;
  const { data: shop, error: shopError } = await supabase.from('restaurants').select('*').eq('slug', restaurantSlug).maybeSingle();
  if (shopError || !shop) { authStatus.textContent = '找不到这家餐馆，请检查网页链接。'; return; }
  restaurant = shop;
  const { data: profile, error: profileError } = await supabase.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
  if (profileError || !profile || !profile.active || profile.restaurant_id !== shop.id) { await supabase.auth.signOut(); user = null; authStatus.textContent = '账号尚未由摊主启用，或不属于此摊位。请联系摊主。'; return; }
  if (profile.must_change_password) {
    authCard.classList.add('hidden'); appArea.classList.remove('hidden');
    $('#first-login-card').classList.remove('hidden'); $('#customer-view').classList.add('hidden'); $('#owner-view').classList.add('hidden');
    $('#account-label').textContent = profile.display_name || '首次登录';
    return;
  }
  accountProfile = profile;
  preferredProductKeys = Array.isArray(profile.preferred_product_keys) ? profile.preferred_product_keys : [];
  const { data: memberships, error: memberError } = await supabase.from('restaurant_memberships').select('role').eq('restaurant_id', restaurant.id).eq('user_id', user.id);
  if (memberError) { authStatus.textContent = `权限检查失败：${memberError.message}`; return; }
  ownerMode = Boolean(memberships?.length);
  authCard.classList.add('hidden');
  appArea.classList.remove('hidden');
  $('#first-login-card').classList.add('hidden');
  $('#account-label').textContent = profile.display_name || user.phone || '已登录';
  $('#restaurant-label').textContent = `${restaurant.name} · ${ownerMode ? '摊主管理' : '顾客下单'}`;
  if (ownerMode) {
    $('#owner-view').classList.remove('hidden');
    try { await seedAndLoadMenu(); }
    catch (error) { $('#owner-menu').textContent = `菜单载入失败：${error.message || '连接超时，请刷新重试。'}`; }
    await Promise.all([
      loadCustomerAccounts().catch((error) => { $('#managed-customers').textContent = `顾客账号载入失败：${error.message || '连接超时，请刷新重试。'}`; }),
      loadOwnerOrders().catch((error) => { $('#owner-orders').textContent = `订单载入失败：${error.message || '连接超时，请刷新重试。'}`; })
    ]);
  } else {
    if (profile.role !== 'customer') { authStatus.textContent = '此账号没有顾客下单权限。'; return; }
    $('#customer-view').classList.remove('hidden');
    await loadCatalog();
    await loadCustomerOrders();
  }
}

async function loadCatalog() {
  const { data, error } = await supabase.from('menu_items').select('*').eq('restaurant_id', restaurant.id).eq('active', true).order('display_order').order('name_zh');
  if (!error && data?.length) catalog = data;
  else catalog = (window.STALL?.products || []).map((p, index) => ({ product_key: p.id, name_zh: p.name, name_en: window.PRODUCT_EN_NAMES?.[p.id] || '', category: p.category, unit: p.unit || '公斤', unit_price: p.price, display_order: index }));
  const livePrices = await fetchLivePrices();
  catalog = catalog.map((p) => ({ ...p, name_en: productEnglishName(p), unit_price: livePrices.get(p.product_key) ?? p.unit_price }));
  const prefResult = await supabase.from('customer_preferences').select('*').eq('restaurant_id', restaurant.id).eq('user_id', user.id);
  const prefs = new Map((prefResult.data || []).map((p) => [p.product_key, p]));
  const assigned = new Set(preferredProductKeys);
  const orderedCatalog = [...catalog].sort((a,b) => Number(assigned.has(b.product_key))-Number(assigned.has(a.product_key)));
  $('#catalog').innerHTML = orderedCatalog.map((p) => {
    const pref = prefs.get(p.product_key), isAssigned = assigned.has(p.product_key);
    const isWeight = isWeightUnit(p.unit);
    const unitOptions = isWeight ? `<option value="weight" ${pref?.mode === 'weight' ? 'selected' : ''}>按重量（Kg）</option><option value="money" ${pref?.mode === 'money' ? 'selected' : ''}>按预算（RM）</option>` : `<option value="count" ${pref?.mode === 'count' ? 'selected' : ''}>按件/包</option><option value="money" ${pref?.mode === 'money' ? 'selected' : ''}>按预算（RM）</option>`;
    const previousAmount = pref?.mode === 'weight' ? formatKgFromGrams(pref.usual_amount) : pref?.usual_amount;
    const suggestion = pref ? `常买 ${escapeHtml(previousAmount)}${pref.mode === 'weight' ? ' Kg' : ''}（本次请重新输入）` : '输入数量/金额';
    const splitField = isWeight ? `<label class="muted">平均分成几份（可选）<input type="number" min="2" step="1" inputmode="numeric" placeholder="不分装" data-split="${escapeHtml(p.product_key)}"></label>` : '';
    return `<div class="item"><strong>${escapeHtml(p.name_zh)}<small>${isAssigned ? '★ 常买 · ' : ''}${escapeHtml(p.name_en)} · ${escapeHtml(p.category)} · ${p.unit_price ? money(p.unit_price)+' / '+escapeHtml(p.unit) : '摊主确认当天价格'}</small></strong><select data-mode="${escapeHtml(p.product_key)}">${unitOptions}</select><input type="number" min="0.1" step="0.1" aria-label="${isWeight ? '重量（Kg）或预算（RM）' : '数量或预算（RM）'}" placeholder="${suggestion}" value="" data-amount="${escapeHtml(p.product_key)}">${splitField}</div>`;
  }).join('');
}

$('#submit-order').addEventListener('click', async () => {
  const items = [];
  for (const p of catalog) {
    const input = document.querySelector(`[data-amount="${CSS.escape(p.product_key)}"]`);
    const amount = Number(input?.value);
    if (!amount) continue;
    const mode = document.querySelector(`[data-mode="${CSS.escape(p.product_key)}"]`).value;
    const splitInput = document.querySelector(`[data-split="${CSS.escape(p.product_key)}"]`);
    const splitValue = splitInput?.value.trim() || '';
    const splitCount = splitValue ? Number(splitValue) : null;
    if (splitValue && (!Number.isInteger(splitCount) || splitCount < 2)) { splitInput.setCustomValidity('请输入 2 或以上的整数份数。'); splitInput.reportValidity(); splitInput.focus(); return; }
    if (splitInput) splitInput.setCustomValidity('');
    const requestedAmount = mode === 'weight' ? Math.round(amount * 1000) : amount;
    items.push({ product_key: p.product_key, product_name: p.name_zh, unit: p.unit || '公斤', request_mode: mode, requested_amount: requestedAmount, requested_unit_price: p.unit_price || null, split_count: splitCount, is_custom: false });
  }
  const custom = $('#custom-items').value.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  custom.forEach((text) => items.push({ product_name: text.slice(0,120), unit: '手写商品', request_mode: 'custom', requested_amount: 1, is_custom: true }));
  const status = $('#order-status');
  if (!items.length) { status.textContent = '请至少选一项商品或填写一项额外要求。'; return; }
  $('#submit-order').disabled = true;
  status.textContent = '正在保存订单…';
  const parentOrderId = $('#add-to-order').value;
  const { data, error } = await supabase.rpc(parentOrderId ? 'submit_addon_order' : 'submit_order', {
    target_restaurant: restaurant.id,
    customer_name: accountProfile?.display_name || '',
    customer_phone: accountProfile?.phone || user.phone || '',
    pickup_note: $('#pickup-note').value.trim(),
    customer_note: $('#customer-note').value.trim(),
    items,
    ...(parentOrderId ? { target_parent: parentOrderId } : {})
  });
  $('#submit-order').disabled = false;
  if (error) { status.textContent = `订单没有保存：${error.message}`; return; }
  const prefs = items.filter((item) => !item.is_custom)
    .map((item) => ({ user_id: user.id, restaurant_id: restaurant.id, product_key: item.product_key, mode: item.request_mode, usual_amount: item.requested_amount }));
  if (prefs.length) await supabase.from('customer_preferences').upsert(prefs, { onConflict: 'user_id,restaurant_id,product_key' });
  status.textContent = parentOrderId
    ? `追加订单已保存，编号 ${data?.[0]?.order_no || ''}，已关联原订单。`
    : `订单已保存，编号 ${data?.[0]?.order_no || ''}。摊主核价后，可在下方查看并确认。`;
  $('#add-to-order').value = '';
  $('#custom-items').value = '';
  await loadCustomerOrders();
});

async function loadCustomerOrders() {
  const { data: orders, error } = await supabase.from('orders').select('id,order_no,status,created_at,pickup_note,customer_note,parent_order_id,parent_order_no,cancel_requested_at,cancel_decided_at,cancel_approved,order_items(*),order_revisions(*)').eq('customer_id', user.id).eq('restaurant_id', restaurant.id).order('created_at', { ascending: false }).limit(30);
  if (error) { $('#customer-orders').textContent = `订单读取失败：${error.message}`; return; }
  const addable = (orders || []).filter((o) => !(o.cancel_requested_at && !o.cancel_decided_at) && ['submitted','owner_review','awaiting_customer_confirmation','customer_requested_change','confirmed'].includes(o.status));
  $('#add-to-order').innerHTML = '<option value="">提交为新订单</option>' + addable.map((o) => `<option value="${escapeHtml(o.id)}">追加至 ${escapeHtml(o.order_no)} · ${escapeHtml(statusName(o.status))}</option>`).join('');
  $('#customer-orders').innerHTML = orders?.length ? orders.map((o) => {
    const revision = (o.order_revisions || []).sort((a,b) => b.revision_no-a.revision_no)[0];
    const revisionLines = revision?.lines || [];
    const itemById = new Map((o.order_items || []).map((line) => [line.id, line]));
    const lineNames = new Map((o.order_items || []).map((line) => [line.id, line.product_name]));
    const cancelAction = !['fulfilled','cancelled'].includes(o.status) && !o.cancel_requested_at ? `<button class="secondary" data-cancel-request="${o.id}">申请取消</button>` : '';
    const cancelMessage = o.cancel_requested_at ? `<p class="muted ${o.cancel_approved === false ? 'danger' : ''}">${o.cancel_decided_at ? (o.cancel_approved ? '摊主已确认取消此单。' : '摊主拒绝了取消申请，订单仍有效。') : '取消申请已送出，等待摊主确认。'}</p>` : '';
    const parentLabel = o.parent_order_no ? `<p class="muted">追加单 · 关联原订单 ${escapeHtml(o.parent_order_no)}</p>` : '';
    return `<article class="order"><div class="row" style="justify-content:space-between"><h3>${escapeHtml(o.order_no)}</h3><span class="pill">${escapeHtml(statusName(o.status))}</span></div><p class="muted">${new Date(o.created_at).toLocaleString()} · ${escapeHtml(o.pickup_note || '取货时间待确认')}</p>${parentLabel}${cancelMessage}<div>${(o.order_items || []).map((line) => `<div class="muted">${escapeHtml(line.product_name)}：${escapeHtml(requestLabel(line))}</div>`).join('')}</div>${revision ? `<hr><strong>摊主最终确认 · ${money(revision.total)}</strong><div>${revisionLines.map((line) => invoiceLineSummary(itemById.get(line.id), line)).join('')}</div>${o.status === 'awaiting_customer_confirmation' ? `<div class="row" style="margin-top:12px"><button data-decision="yes" data-order="${o.id}" data-revision="${revision.id}">确认最终订单</button><button class="secondary" data-decision="no" data-order="${o.id}" data-revision="${revision.id}">请摊主修改</button></div>` : ''}` : ''}<div class="row" style="margin-top:12px">${cancelAction}</div></article>`;
  }).join('') : '<p class="muted">还没有网站订单。</p>';
}

$('#customer-orders').addEventListener('click', async (event) => {
  const cancel = event.target.closest('[data-cancel-request]');
  if (cancel) {
    if (!confirm('要向摊主提交这张订单的取消申请吗？订单不会立即删除，摊主确认后才会取消。')) return;
    const { error } = await supabase.rpc('customer_request_order_cancel', { target_order: cancel.dataset.cancelRequest });
    if (error) alert(`取消申请未送出：${error.message}`); else await loadCustomerOrders();
    return;
  }
  const button = event.target.closest('[data-decision]');
  if (!button) return;
  const { error } = await supabase.rpc('customer_decide_order', { target_order: button.dataset.order, target_revision: button.dataset.revision, accept: button.dataset.decision === 'yes' });
  if (error) alert(`保存失败：${error.message}`); else await loadCustomerOrders();
});

function normalizePhone(value) {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  digits = digits.replace(/\D/g, '');
  return digits.startsWith('0') ? `+60${digits.slice(1)}` : `+${digits}`;
}

// Supabase phone login requires an SMS provider. Use a reserved, non-deliverable
// internal email identifier so customers still sign in with their phone number
// without SMS, an email address, or another paid service.
function loginEmailForPhone(phone) {
  return `${String(phone).replace(/\D/g, '')}@login.market-stall.invalid`;
}

async function invokeCustomerAdmin(body) {
  const { data, error } = await supabase.functions.invoke('customer-admin', { body: { restaurant_id: restaurant.id, ...body } });
  if (error) throw new Error(error.message || '账号管理请求失败');
  if (data?.error) throw new Error(data.error);
  return data;
}

async function loadCustomerAccounts() {
  const box = $('#managed-customers');
  const { data, error } = await supabase.from('profiles').select('user_id,display_name,phone,customer_slot,active,preferred_product_keys').eq('restaurant_id', restaurant.id).eq('role', 'customer').order('customer_slot');
  if (error) { box.textContent = `顾客账号读取失败：${error.message}`; return; }
  const active = (data || []).filter((x) => x.active);
  box.innerHTML = `<h3>目前 ${active.length} 个启用中的顾客账号（可持续新增）</h3>` + ((data || []).map((customer) => `<article class="order"><strong>#${customer.customer_slot ?? '—'} ${escapeHtml(customer.display_name)} ${customer.active ? '' : '（已停用）'}</strong><p class="muted">${escapeHtml(customer.phone || '')}<br>常买：${(customer.preferred_product_keys || []).map((key) => escapeHtml(catalog.find((p) => p.product_key === key)?.name_zh || key)).join('、') || '尚未设置'}</p>${customer.active ? `<details><summary>编辑常买偏好（最多 40 项）</summary><div class="row">${catalog.map((p) => `<label class="pill"><input type="checkbox" value="${escapeHtml(p.product_key)}" data-account-pref="${customer.user_id}" ${(customer.preferred_product_keys || []).includes(p.product_key) ? 'checked' : ''}> ${escapeHtml(p.name_zh)}</label>`).join('')}</div><button class="secondary" data-save-account-prefs="${customer.user_id}">保存偏好</button></details><p><button class="secondary" data-reset-customer="${customer.user_id}">重设临时密码</button> <button class="secondary" data-deactivate-customer="${customer.user_id}">停用账号</button></p>` : `<button class="secondary" data-reactivate-customer="${customer.user_id}">重新启用并生成临时密码</button>`}</article>`).join('') || '<p class="muted">尚未建立顾客账号。</p>');
}

async function renderPreferenceChoices() {
  if (!catalog.length) {
    const { data } = await supabase.from('menu_items').select('product_key,name_zh').eq('restaurant_id', restaurant.id).eq('active', true).order('display_order');
    catalog = data || [];
  }
  $('#new-customer-preferences').innerHTML = catalog.map((p) => `<label class="pill"><input type="checkbox" value="${escapeHtml(p.product_key)}" data-new-customer-preference> ${escapeHtml(p.name_zh)}<small style="display:block">${escapeHtml(productEnglishName(p))}</small></label>`).join('');
  $('#new-customer-preferences').onchange = (event) => {
    if (!event.target.matches('[data-new-customer-preference]')) return;
    const checked = [...document.querySelectorAll('[data-new-customer-preference]:checked')];
    if (checked.length > 40) { event.target.checked = false; $('#temp-password-result').textContent = '每位顾客最多设定 40 项常买偏好。'; }
  };
}

$('#create-customer').addEventListener('click', async () => {
  const status = $('#temp-password-result');
  const display_name = $('#new-customer-name').value.trim(), phone = normalizePhone($('#new-customer-phone').value);
  const preferred_product_keys = [...document.querySelectorAll('[data-new-customer-preference]:checked')].map((x) => x.value);
  if (!display_name || !phone) { status.textContent = '请填写顾客姓名和手机号码。'; return; }
  const button = $('#create-customer'); button.disabled = true; status.textContent = '正在创建账号…';
  try {
    const result = await invokeCustomerAdmin({ action: 'create', display_name, phone, preferred_product_keys });
    status.innerHTML = `账号已创建。请把以下临时密码交给顾客（只显示这一次）：<br><strong>${escapeHtml(result.temporary_password)}</strong> <button type="button" class="secondary" data-copy-temp>复制密码</button> <span class="muted" data-copy-feedback role="status" aria-live="polite"></span>`;
    $('#new-customer-name').value = ''; $('#new-customer-phone').value = '';
    await renderPreferenceChoices(); await loadCustomerAccounts();
  } catch (error) { status.textContent = `创建失败：${error.message}`; }
  button.disabled = false;
});

$('#temp-password-result').addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy-temp]');
  if (!copyButton) return;
  const password = $('#temp-password-result strong')?.textContent;
  if (!password) return;
  const feedback = $('#temp-password-result [data-copy-feedback]');
  copyButton.disabled = true;
  feedback.textContent = '正在复制…';
  try {
    await copyText(password);
    copyButton.textContent = '已复制';
    feedback.textContent = '临时密码已复制，可以粘贴给顾客。';
  } catch (error) {
    feedback.textContent = `自动复制失败：${error.message}。请手动选择上方密码复制。`;
  } finally {
    copyButton.disabled = false;
  }
});

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch { /* Fall through to the selection-based copy path. */ }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  let copied = false;
  try {
    field.select();
    copied = document.execCommand('copy');
  } finally {
    field.remove();
  }
  if (!copied) throw new Error('浏览器未允许剪贴板访问');
}

$('#managed-customers').addEventListener('click', async (event) => {
  const reset = event.target.closest('[data-reset-customer]'), deactivate = event.target.closest('[data-deactivate-customer]');
  const savePrefs = event.target.closest('[data-save-account-prefs]'), reactivate = event.target.closest('[data-reactivate-customer]');
  if (!reset && !deactivate && !savePrefs && !reactivate) return;
  const status = $('#temp-password-result');
  try {
    if (savePrefs) {
      const customerId = savePrefs.dataset.saveAccountPrefs;
      const preferred_product_keys = [...document.querySelectorAll(`[data-account-pref="${CSS.escape(customerId)}"]:checked`)].map((x) => x.value);
      await invokeCustomerAdmin({ action: 'set_preferences', customer_id: customerId, preferred_product_keys });
      status.textContent = '常买偏好已保存。'; await loadCustomerAccounts();
    } else if (reactivate) {
      const result = await invokeCustomerAdmin({ action: 'reactivate', customer_id: reactivate.dataset.reactivateCustomer });
      status.innerHTML = `账号已重新启用。新临时密码（只显示这一次）：<br><strong>${escapeHtml(result.temporary_password)}</strong> <button type="button" class="secondary" data-copy-temp>复制密码</button> <span class="muted" data-copy-feedback role="status" aria-live="polite"></span>`;
      await loadCustomerAccounts();
    } else if (reset) {
      const result = await invokeCustomerAdmin({ action: 'reset', customer_id: reset.dataset.resetCustomer });
      status.innerHTML = `新临时密码（只显示这一次）：<br><strong>${escapeHtml(result.temporary_password)}</strong> <button type="button" class="secondary" data-copy-temp>复制密码</button> <span class="muted" data-copy-feedback role="status" aria-live="polite"></span>`;
    } else if (confirm('确定停用这个顾客账号？历史订单会保留。')) {
      await invokeCustomerAdmin({ action: 'deactivate', customer_id: deactivate.dataset.deactivateCustomer });
      status.textContent = '顾客账号已停用。'; await loadCustomerAccounts();
    }
  } catch (error) { status.textContent = `操作失败：${error.message}`; }
});

function requestLabel(line) { const base = line.request_mode === 'money' ? `预算 RM ${Number(line.requested_amount).toFixed(2)}` : line.request_mode === 'weight' ? `${formatKgFromGrams(line.requested_amount)} Kg` : line.request_mode === 'count' ? `${line.requested_amount} 件/包` : '请摊主确认'; return line.split_count ? `${base}；请平均分 ${line.split_count} 份${line.request_mode === 'weight' && isWeightUnit(line.unit) ? `（约每份 ${(Number(line.requested_amount) / 1000 / line.split_count).toFixed(2)} Kg）` : ''}` : base; }
function invoiceLineSummary(item, line) {
  if (!item) return `<div class="muted">商品：${money(line.final_amount)}</div>`;
  if (line.availability === 'unavailable') return `<div class="muted">${escapeHtml(item.product_name)}：缺货（RM 0.00）</div>`;
  if (item.is_custom) return `<div class="muted">${escapeHtml(item.product_name)}：代购最终金额 ${money(line.final_amount)}</div>`;
  const split = item.split_count && isWeightUnit(item.unit) && line.final_quantity ? ` · 分 ${item.split_count} 份（每份约 ${(Number(line.final_quantity) / 1000 / item.split_count).toFixed(2)} Kg）` : '';
  if (isWeightUnit(item.unit)) {
    const actualKg = formatKgFromGrams(line.final_quantity);
    const price = Number(line.final_unit_price ?? item.requested_unit_price);
    const priced = Number.isFinite(price) ? ` × RM ${price.toFixed(2)}/Kg` : '';
    return `<div class="muted">${escapeHtml(item.product_name)}：顾客原订 ${escapeHtml(requestLabel(item))} → 实称 ${actualKg} Kg${priced} = ${money(line.final_amount)}${split}</div>`;
  }
  const quantity = Number(line.final_quantity || 0);
  const price = Number(line.final_unit_price ?? item.requested_unit_price);
  const priced = Number.isFinite(price) ? ` × RM ${price.toFixed(2)}/${escapeHtml(item.unit)}` : '';
  return `<div class="muted">${escapeHtml(item.product_name)}：顾客原订 ${escapeHtml(requestLabel(item))} → 实际 ${quantity} ${escapeHtml(item.unit)}${priced} = ${money(line.final_amount)}</div>`;
}
function statusName(value) { return ({submitted:'已提交，待摊主处理',owner_review:'摊主核价中',awaiting_customer_confirmation:'待你确认最终金额',customer_requested_change:'你已要求修改',confirmed:'你已确认',fulfilled:'已完成',cancelled:'已取消'})[value] || value; }

async function seedAndLoadMenu() {
  if (window.STALL?.products?.length) {
    const { data: existing, error: readError } = await supabase.from('menu_items').select('id,product_key,name_zh,name_en,category,unit,active,display_order').eq('restaurant_id', restaurant.id);
    if (readError) { $('#owner-menu').textContent = `菜单读取失败：${readError.message}`; return; }
    const existingByKey = new Map((existing || []).map((row) => [row.product_key, row]));
    const desiredKeys = new Set(window.STALL.products.map((product) => product.id));
    const additions = window.STALL.products.map((p,index) => ({ restaurant_id: restaurant.id, product_key: p.id, name_zh: p.name, name_en: window.PRODUCT_EN_NAMES?.[p.id] || '', category: p.category, unit: p.unit || '公斤', unit_price: p.price, display_order: index, active: true })).filter((row) => !existingByKey.has(row.product_key));
    if (additions.length) {
      const { error } = await supabase.from('menu_items').insert(additions);
      if (error) { $('#owner-menu').textContent = `菜单新增商品失败：${error.message}`; return; }
    }
    const updates = window.STALL.products.flatMap((product) => {
      const current = existingByKey.get(product.id);
      if (!current) return [];
      const desired = { name_zh: product.name, name_en: window.PRODUCT_EN_NAMES?.[product.id] || '', category: product.category, unit: product.unit || '公斤', active: true };
      if (Object.entries(desired).every(([key, value]) => current[key] === value)) return [];
      return [supabase.from('menu_items').update(desired).eq('id', current.id)];
    });
    const updateResults = await Promise.all(updates);
    const failedUpdate = updateResults.find((result) => result.error);
    if (failedUpdate) { $('#owner-menu').textContent = `菜单同步失败：${failedUpdate.error.message}`; return; }
    const obsolete = (existing || []).filter((row) => !desiredKeys.has(row.product_key));
    const obsoleteResults = await Promise.all(obsolete.filter((row) => row.active).map((row) => supabase.from('menu_items').update({ active: false }).eq('id', row.id)));
    const failedObsolete = obsoleteResults.find((result) => result.error);
    if (failedObsolete) { $('#owner-menu').textContent = `旧菜单项目停用失败：${failedObsolete.error.message}`; return; }
  }
  await loadOwnerMenu();
  await renderPreferenceChoices();
}

async function loadOwnerMenu() {
  const { data, error } = await supabase.from('menu_items').select('*').eq('restaurant_id', restaurant.id).eq('active', true).order('display_order').order('name_zh');
  if (error) { $('#owner-menu').textContent = `菜单读取失败：${error.message}`; return; }
  $('#owner-menu').innerHTML = (data || []).map((p,index) => `<div class="item"><strong>${escapeHtml(p.name_zh)}<small>${escapeHtml(productEnglishName(p))}</small><small>${escapeHtml(p.category)}</small></strong><span class="muted">${escapeHtml(p.unit)}${p.unit_price ? ` · ${money(p.unit_price)}` : ''}</span><button class="secondary" data-move="up" data-id="${p.id}" ${index===0?'disabled':''}>↑</button><button class="secondary" data-move="down" data-id="${p.id}" ${index===data.length-1?'disabled':''}>↓</button></div>`).join('') || '菜单没有商品。';
  $('#owner-menu').onclick = async (event) => {
    const button = event.target.closest('[data-move]'); if (!button) return;
    const current = data.findIndex((p) => p.id === button.dataset.id), target = current + (button.dataset.move === 'up' ? -1 : 1);
    if (target < 0 || target >= data.length) return;
    const first = data[current], second = data[target];
    await supabase.from('menu_items').update({ display_order: second.display_order }).eq('id', first.id);
    await supabase.from('menu_items').update({ display_order: first.display_order }).eq('id', second.id);
    await loadOwnerMenu();
  };
}

async function fetchLivePrices() {
  const prices = new Map();
  try {
    const url = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQh3wCEEaEa1MvOtc8hXuucdMrJd4RXs8KdybXB7Xnc4iFC8HhK6GPK9_PbCxiLM6MDuSe_-SE7AiOf/pub?gid=2036321990&single=true&output=csv';
    const response = await fetchWithTimeout(url, { cache: 'no-store' });
    if (!response.ok) return prices;
    const rows = parseCsv(await response.text());
    if (rows.length < 2) return prices;
    const heads = rows[0].map((x) => x.trim()), dateCol = heads.indexOf('日期'), idCol = heads.indexOf('商品名称'), priceCol = heads.findIndex((x) => x.startsWith('价格'));
    const latest = new Map();
    for (const row of rows.slice(1)) {
      const key = String(row[idCol] || '').trim(), raw = String(row[priceCol] || '').replace(/[RM\s,]/g, ''), date = sheetDate(row[dateCol]);
      if (dateCol < 0 || idCol < 0 || priceCol < 0 || !key || !date || raw === '' || !Number.isFinite(Number(raw))) continue;
      if (!latest.has(key) || latest.get(key).date <= date) latest.set(key, { date, price: Number(raw) });
    }
    for (const [key,value] of latest) prices.set(key,value.price);
  } catch { /* Use menu snapshot prices when the public sheet is unavailable. */ }
  return prices;
}

function parseCsv(text) {
  const rows=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}return rows;
}
function sheetDate(value) {
  let m=String(value||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m)return Date.UTC(+m[3],+m[2]-1,+m[1]);
  m=String(value||'').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m?Date.UTC(+m[1],+m[2]-1,+m[3]):0;
}

async function loadOwnerOrders() {
  const { data, error } = await supabase.from('orders').select('id,order_no,status,created_at,customer_name,customer_phone,customer_id,pickup_note,customer_note,parent_order_id,parent_order_no,cancel_requested_at,cancel_decided_at,cancel_approved,order_items(*)').eq('restaurant_id', restaurant.id).neq('status','fulfilled').order('created_at',{ascending:false}).limit(100);
  if (error) { $('#owner-orders').textContent = `订单读取失败：${error.message}`; return; }
  $('#owner-orders').innerHTML = data?.length ? data.map((o) => `<article class="order" data-owner-order="${o.id}"><div class="row" style="justify-content:space-between"><h3>${escapeHtml(o.order_no)} · ${escapeHtml(o.customer_name || '顾客')}</h3><span class="pill">${escapeHtml(statusName(o.status))}</span></div><p class="muted">顾客电话：${escapeHtml(o.customer_phone || '未提供')} · ${new Date(o.created_at).toLocaleString()} · ${escapeHtml(o.pickup_note || '未提供取货时间')}</p>${o.parent_order_no ? `<p class="muted">追加单 · 关联原订单 ${escapeHtml(o.parent_order_no)}</p>` : ''}${o.cancel_requested_at && !o.cancel_decided_at ? `<div class="card"><strong>顾客申请取消此单</strong><div class="row" style="margin-top:8px"><button data-cancel-decision="approve" data-order="${o.id}">确认取消</button><button class="secondary" data-cancel-decision="decline" data-order="${o.id}">拒绝取消，保留订单</button></div></div>` : o.cancel_requested_at ? `<p class="muted">取消申请处理结果：${o.cancel_approved ? '已确认取消' : '已拒绝取消'}</p>` : ''}<p class="muted">备注：${escapeHtml(o.customer_note || '无')}</p>${(o.order_items||[]).map((line) => {
    const weight = isWeightUnit(line.unit), requested = requestLabel(line);
    const actualValue = line.final_quantity == null ? '' : (weight ? formatKgFromGrams(line.final_quantity) : line.final_quantity);
    const priceValue = line.is_custom ? (line.final_amount ?? '') : (line.final_unit_price ?? line.requested_unit_price ?? '');
    const priceLocked = !line.is_custom && line.requested_unit_price != null;
    const unitLabel = weight ? 'Kg' : line.unit;
    return `<div class="ownerline" data-line="${line.id}" data-unit="${escapeHtml(line.unit)}" data-split="${escapeHtml(line.split_count ?? '')}" data-custom="${line.is_custom}"><strong>${escapeHtml(line.product_name)}</strong><div class="weight-cell"><small>顾客原订</small><strong>${escapeHtml(requested)}</strong></div><label class="weight-cell">${weight ? '实际称重 (Kg)' : '实际数量'}<input type="number" min="0" step="${weight ? '0.001' : '1'}" inputmode="decimal" data-final-qty value="${escapeHtml(actualValue)}" placeholder="${weight ? '如 2.1' : '输入数量'}"></label><select aria-label="${escapeHtml(line.product_name)}有货状态" data-availability><option value="pending" ${line.availability==='pending'?'selected':''}>待确认</option><option value="available" ${line.availability==='available'?'selected':''}>有货</option><option value="unavailable" ${line.availability==='unavailable'?'selected':''}>缺货</option></select><label class="price-cell">${line.is_custom ? '代购最终金额 (RM)' : `网页单价 (RM/${escapeHtml(unitLabel)})`}<input type="number" min="0" step="0.01" data-final-price value="${escapeHtml(priceValue)}" placeholder="${line.is_custom ? '最终金额 RM' : '网页未提供单价'}" ${priceLocked ? 'readonly' : ''}>${priceLocked ? '<small>自动沿用顾客下单时网页显示的价格</small>' : ''}</label><small class="muted" data-portion-preview>${line.split_count && line.final_quantity && weight ? `实称后每份约 ${(Number(line.final_quantity)/1000/line.split_count).toFixed(2)} Kg；分装不改变总价。` : line.split_count ? `平均分 ${line.split_count} 份；分装不改变总价。` : ''}</small></div>`;
  }).join('')}${!o.cancel_requested_at || o.cancel_decided_at ? ['submitted','owner_review','customer_requested_change'].includes(o.status) ? `<button data-publish="${o.id}">计算并发给顾客确认</button>` : o.status==='confirmed' ? `<button data-fulfill="${o.id}">标记已备货/完成</button>` : '' : ''}<div class="status" data-order-status></div></article>`).join('') : '<p class="muted">目前没有待处理订单。</p>';
}

$('#owner-orders').addEventListener('input', (event) => {
  if (!event.target.matches('[data-final-qty]')) return;
  const row = event.target.closest('[data-line]'), preview = row?.querySelector('[data-portion-preview]');
  if (!row || !preview || row.dataset.unit !== '公斤' || !row.dataset.split) return;
  const grams = Number(event.target.value) * 1000, portions = Number(row.dataset.split);
  preview.textContent = grams > 0 ? `实称后每份约 ${(grams / 1000 / portions).toFixed(2)} Kg；分装不改变总价。` : `平均分 ${portions} 份；分装不改变总价。`;
});

$('#owner-orders').addEventListener('click', async (event) => {
  const cancelDecision = event.target.closest('[data-cancel-decision]');
  if (cancelDecision) {
    const approve = cancelDecision.dataset.cancelDecision === 'approve';
    const message = approve ? '确认取消这张订单吗？记录会保留在历史中。' : '拒绝取消申请并保留此订单？';
    if (!confirm(message)) return;
    const { error } = await supabase.rpc('owner_decide_order_cancellation', { target_order: cancelDecision.dataset.order, approve });
    if (error) alert(`操作失败：${error.message}`); else await loadOwnerOrders();
    return;
  }
  const fulfilled = event.target.closest('[data-fulfill]');
  if (fulfilled) {
    const { error } = await supabase.rpc('owner_mark_fulfilled', { target_order: fulfilled.dataset.fulfill });
    if (error) alert(`更新失败：${error.message}`); else await loadOwnerOrders();
    return;
  }
  const button = event.target.closest('[data-publish]'); if (!button) return;
  const card = button.closest('[data-owner-order]');
  const lines = [...card.querySelectorAll('[data-line]')].map((row) => {
    const rawQuantity = row.querySelector('[data-final-qty]').value;
    const quantityInDatabaseUnits = row.dataset.unit === '公斤' || row.dataset.unit === 'kg' || row.dataset.unit === 'KG'
      ? (rawQuantity === '' ? '' : String(Math.round(Number(rawQuantity) * 1000)))
      : rawQuantity;
    return {
      id: row.dataset.line,
      availability: row.querySelector('[data-availability]').value,
      final_quantity: quantityInDatabaseUnits,
      final_unit_price: row.dataset.custom === 'true' ? '' : row.querySelector('[data-final-price]').value,
      manual_amount: row.dataset.custom === 'true' ? row.querySelector('[data-final-price]').value : ''
    };
  });
  if (lines.some((line) => line.availability === 'pending' || (line.availability === 'available' && ((!line.manual_amount && !line.final_unit_price) || (line.manual_amount && Number(line.manual_amount) < 0) || (line.final_unit_price && Number(line.final_unit_price) < 0))))) {
    card.querySelector('[data-order-status]').textContent = '请为每项选择有货/缺货，并填写有货商品的最终价格。'; return;
  }
  button.disabled = true;
  const { data, error } = await supabase.rpc('owner_publish_revision', { target_order: button.dataset.publish, lines });
  button.disabled = false;
  card.querySelector('[data-order-status]').textContent = error ? `没有发布：${error.message}` : `最终总额 ${money(data?.[0]?.total)}，顾客登录网站即可确认。`;
  if (!error) await loadOwnerOrders();
});

if (supabase) {
  const { data } = await supabase.auth.getSession();
  if (data.session) { user = data.session.user; await openApp(); }
}

$('#phone').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#password-sign-in').click(); });
$('#password').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#password-sign-in').click(); });
