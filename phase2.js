import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $ = (selector) => document.querySelector(selector);
const config = window.SUPABASE_CONFIG;
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
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

if (!config?.url || !config?.anonKey || config.url.includes('YOUR-PROJECT') || config.anonKey.includes('YOUR-SUPABASE')) {
  setupWarning.classList.remove('hidden');
  authCard.classList.add('hidden');
} else {
  supabase = createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
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
    await seedAndLoadMenu();
    await loadCustomerAccounts();
    await loadOwnerOrders();
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
  catalog = catalog.map((p) => ({ ...p, unit_price: livePrices.get(p.product_key) ?? p.unit_price }));
  const prefResult = await supabase.from('customer_preferences').select('*').eq('restaurant_id', restaurant.id).eq('user_id', user.id);
  const prefs = new Map((prefResult.data || []).map((p) => [p.product_key, p]));
  const assigned = new Set(preferredProductKeys);
  const orderedCatalog = [...catalog].sort((a,b) => Number(assigned.has(b.product_key))-Number(assigned.has(a.product_key)));
  $('#catalog').innerHTML = orderedCatalog.map((p) => {
    const pref = prefs.get(p.product_key), isAssigned = assigned.has(p.product_key);
    const unitOptions = p.unit === '公斤' || p.unit === 'kg' ? `<option value="weight" ${pref?.mode === 'weight' ? 'selected' : ''}>按重量（克）</option><option value="money" ${pref?.mode === 'money' ? 'selected' : ''}>按预算（RM）</option>` : `<option value="count" ${pref?.mode === 'count' ? 'selected' : ''}>按件/包</option><option value="money" ${pref?.mode === 'money' ? 'selected' : ''}>按预算（RM）</option>`;
    const suggestion = pref ? `常买 ${escapeHtml(pref.usual_amount)}（本次请重新输入）` : '输入数量/金额';
    return `<div class="item"><strong>${escapeHtml(p.name_zh)}<small>${isAssigned ? '★ 常买 · ' : ''}${escapeHtml(p.name_en)} · ${escapeHtml(p.category)} · ${p.unit_price ? money(p.unit_price)+' / '+escapeHtml(p.unit) : '摊主确认当天价格'}</small></strong><select data-mode="${escapeHtml(p.product_key)}">${unitOptions}</select><input type="number" min="0.1" step="0.1" placeholder="${suggestion}" value="" data-amount="${escapeHtml(p.product_key)}"></div>`;
  }).join('');
}

$('#submit-order').addEventListener('click', async () => {
  const items = [];
  for (const p of catalog) {
    const input = document.querySelector(`[data-amount="${CSS.escape(p.product_key)}"]`);
    const amount = Number(input?.value);
    if (!amount) continue;
    const mode = document.querySelector(`[data-mode="${CSS.escape(p.product_key)}"]`).value;
    items.push({ product_key: p.product_key, product_name: p.name_zh, unit: p.unit || '公斤', request_mode: mode, requested_amount: amount, requested_unit_price: p.unit_price || null, is_custom: false });
  }
  const custom = $('#custom-items').value.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  custom.forEach((text) => items.push({ product_name: text.slice(0,120), unit: '手写商品', request_mode: 'custom', requested_amount: 1, is_custom: true }));
  const status = $('#order-status');
  if (!items.length) { status.textContent = '请至少选一项商品或填写一项额外要求。'; return; }
  $('#submit-order').disabled = true;
  status.textContent = '正在保存订单…';
  const { data, error } = await supabase.rpc('submit_order', {
    target_restaurant: restaurant.id,
    customer_name: accountProfile?.display_name || '',
    customer_phone: accountProfile?.phone || user.phone || '',
    pickup_note: $('#pickup-note').value.trim(),
    customer_note: $('#customer-note').value.trim(),
    items
  });
  $('#submit-order').disabled = false;
  if (error) { status.textContent = `订单没有保存：${error.message}`; return; }
  const prefs = items.filter((item) => !item.is_custom)
    .map((item) => ({ user_id: user.id, restaurant_id: restaurant.id, product_key: item.product_key, mode: item.request_mode, usual_amount: item.requested_amount }));
  if (prefs.length) await supabase.from('customer_preferences').upsert(prefs, { onConflict: 'user_id,restaurant_id,product_key' });
  status.textContent = `订单已保存，编号 ${data?.[0]?.order_no || ''}。摊主核价后，可在下方查看并确认。`;
  $('#custom-items').value = '';
  await loadCustomerOrders();
});

async function loadCustomerOrders() {
  const { data: orders, error } = await supabase.from('orders').select('id,order_no,status,created_at,pickup_note,customer_note,order_items(*),order_revisions(*)').eq('customer_id', user.id).eq('restaurant_id', restaurant.id).order('created_at', { ascending: false }).limit(30);
  if (error) { $('#customer-orders').textContent = `订单读取失败：${error.message}`; return; }
  $('#customer-orders').innerHTML = orders?.length ? orders.map((o) => {
    const revision = (o.order_revisions || []).sort((a,b) => b.revision_no-a.revision_no)[0];
    const revisionLines = revision?.lines || [];
    const lineNames = new Map((o.order_items || []).map((line) => [line.id, line.product_name]));
    return `<article class="order"><div class="row" style="justify-content:space-between"><h3>${escapeHtml(o.order_no)}</h3><span class="pill">${escapeHtml(statusName(o.status))}</span></div><p class="muted">${new Date(o.created_at).toLocaleString()} · ${escapeHtml(o.pickup_note || '取货时间待确认')}</p><div>${(o.order_items || []).map((line) => `<div class="muted">${escapeHtml(line.product_name)}：${escapeHtml(requestLabel(line))}</div>`).join('')}</div>${revision ? `<hr><strong>摊主最终确认 · ${money(revision.total)}</strong><div>${revisionLines.map((line) => `<div class="muted">${escapeHtml(lineNames.get(line.id) || '商品')}：${line.availability === 'unavailable' ? '缺货' : (line.final_quantity ? `${escapeHtml(line.final_quantity)} ${escapeHtml((o.order_items || []).find(x=>x.id===line.id)?.unit === '公斤' ? '克' : '')} · ${money(line.final_amount)}` : money(line.final_amount))}</div>`).join('')}</div>${o.status === 'awaiting_customer_confirmation' ? `<div class="row" style="margin-top:12px"><button data-decision="yes" data-order="${o.id}" data-revision="${revision.id}">确认最终订单</button><button class="secondary" data-decision="no" data-order="${o.id}" data-revision="${revision.id}">请摊主修改</button></div>` : ''}` : ''}</article>`;
  }).join('') : '<p class="muted">还没有网站订单。</p>';
}

$('#customer-orders').addEventListener('click', async (event) => {
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
  box.innerHTML = `<h3>目前 ${active.length} 个启用中的顾客账号（可持续新增）</h3>` + ((data || []).map((customer) => `<article class="order"><strong>#${customer.customer_slot ?? '—'} ${escapeHtml(customer.display_name)} ${customer.active ? '' : '（已停用）'}</strong><p class="muted">${escapeHtml(customer.phone || '')}<br>常买：${(customer.preferred_product_keys || []).map((key) => escapeHtml(catalog.find((p) => p.product_key === key)?.name_zh || key)).join('、') || '尚未设置'}</p>${customer.active ? `<details><summary>编辑常买偏好（最多 10 项）</summary><div class="row">${catalog.map((p) => `<label class="pill"><input type="checkbox" value="${escapeHtml(p.product_key)}" data-account-pref="${customer.user_id}" ${(customer.preferred_product_keys || []).includes(p.product_key) ? 'checked' : ''}> ${escapeHtml(p.name_zh)}</label>`).join('')}</div><button class="secondary" data-save-account-prefs="${customer.user_id}">保存偏好</button></details><p><button class="secondary" data-reset-customer="${customer.user_id}">重设临时密码</button> <button class="secondary" data-deactivate-customer="${customer.user_id}">停用账号</button></p>` : `<button class="secondary" data-reactivate-customer="${customer.user_id}">重新启用并生成临时密码</button>`}</article>`).join('') || '<p class="muted">尚未建立顾客账号。</p>');
}

async function renderPreferenceChoices() {
  if (!catalog.length) {
    const { data } = await supabase.from('menu_items').select('product_key,name_zh').eq('restaurant_id', restaurant.id).eq('active', true).order('display_order');
    catalog = data || [];
  }
  $('#new-customer-preferences').innerHTML = catalog.map((p) => `<label class="pill"><input type="checkbox" value="${escapeHtml(p.product_key)}" data-new-customer-preference> ${escapeHtml(p.name_zh)}</label>`).join('');
  $('#new-customer-preferences').onchange = (event) => {
    if (!event.target.matches('[data-new-customer-preference]')) return;
    const checked = [...document.querySelectorAll('[data-new-customer-preference]:checked')];
    if (checked.length > 10) { event.target.checked = false; $('#temp-password-result').textContent = '每位顾客最多设定 10 项常买偏好。'; }
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
    status.innerHTML = `账号已创建。请把以下临时密码交给顾客（只显示这一次）：<br><strong>${escapeHtml(result.temporary_password)}</strong> <button class="secondary" data-copy-temp>复制密码</button>`;
    $('#new-customer-name').value = ''; $('#new-customer-phone').value = '';
    await renderPreferenceChoices(); await loadCustomerAccounts();
  } catch (error) { status.textContent = `创建失败：${error.message}`; }
  button.disabled = false;
});

$('#managed-customers').addEventListener('click', async (event) => {
  const reset = event.target.closest('[data-reset-customer]'), deactivate = event.target.closest('[data-deactivate-customer]');
  if (event.target.closest('[data-copy-temp]')) { await navigator.clipboard.writeText($('#temp-password-result strong').textContent); return; }
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
      status.innerHTML = `账号已重新启用。新临时密码（只显示这一次）：<br><strong>${escapeHtml(result.temporary_password)}</strong> <button class="secondary" data-copy-temp>复制密码</button>`;
      await loadCustomerAccounts();
    } else if (reset) {
      const result = await invokeCustomerAdmin({ action: 'reset', customer_id: reset.dataset.resetCustomer });
      status.innerHTML = `新临时密码（只显示这一次）：<br><strong>${escapeHtml(result.temporary_password)}</strong> <button class="secondary" data-copy-temp>复制密码</button>`;
    } else if (confirm('确定停用这个顾客账号？历史订单会保留。')) {
      await invokeCustomerAdmin({ action: 'deactivate', customer_id: deactivate.dataset.deactivateCustomer });
      status.textContent = '顾客账号已停用。'; await loadCustomerAccounts();
    }
  } catch (error) { status.textContent = `操作失败：${error.message}`; }
});

function requestLabel(line) { return line.request_mode === 'money' ? `预算 RM ${Number(line.requested_amount).toFixed(2)}` : line.request_mode === 'weight' ? `${line.requested_amount} 克（要求重量）` : line.request_mode === 'count' ? `${line.requested_amount} 件/包` : '请摊主确认'; }
function statusName(value) { return ({submitted:'已提交，待摊主处理',owner_review:'摊主核价中',awaiting_customer_confirmation:'待你确认最终金额',customer_requested_change:'你已要求修改',confirmed:'你已确认',fulfilled:'已完成',cancelled:'已取消'})[value] || value; }

async function seedAndLoadMenu() {
  const { data: existing } = await supabase.from('menu_items').select('id').eq('restaurant_id', restaurant.id).limit(1);
  if (!existing?.length && window.STALL?.products?.length) {
    const rows = window.STALL.products.map((p,index) => ({ restaurant_id: restaurant.id, product_key: p.id, name_zh: p.name, name_en: window.PRODUCT_EN_NAMES?.[p.id] || '', category: p.category, unit: p.unit || '公斤', unit_price: p.price, display_order: index }));
    const { error } = await supabase.from('menu_items').upsert(rows, { onConflict: 'restaurant_id,product_key' });
    if (error) { $('#owner-menu').textContent = `菜单初始化失败：${error.message}`; return; }
  }
  await loadOwnerMenu();
  await renderPreferenceChoices();
}

async function loadOwnerMenu() {
  const { data, error } = await supabase.from('menu_items').select('*').eq('restaurant_id', restaurant.id).order('display_order').order('name_zh');
  if (error) { $('#owner-menu').textContent = `菜单读取失败：${error.message}`; return; }
  $('#owner-menu').innerHTML = (data || []).map((p,index) => `<div class="item"><strong>${escapeHtml(p.name_zh)}<small>${escapeHtml(p.category)}</small></strong><span class="muted">${escapeHtml(p.unit)}${p.unit_price ? ` · ${money(p.unit_price)}` : ''}</span><button class="secondary" data-move="up" data-id="${p.id}" ${index===0?'disabled':''}>↑</button><button class="secondary" data-move="down" data-id="${p.id}" ${index===data.length-1?'disabled':''}>↓</button></div>`).join('') || '菜单没有商品。';
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
    const response = await fetch(url, { cache: 'no-store' });
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
  const { data, error } = await supabase.from('orders').select('id,order_no,status,created_at,customer_name,customer_phone,customer_id,pickup_note,customer_note,order_items(*)').eq('restaurant_id', restaurant.id).not('status','in','(fulfilled,cancelled)').order('created_at',{ascending:true}).limit(100);
  if (error) { $('#owner-orders').textContent = `订单读取失败：${error.message}`; return; }
  $('#owner-orders').innerHTML = data?.length ? data.map((o) => `<article class="order" data-owner-order="${o.id}"><div class="row" style="justify-content:space-between"><h3>${escapeHtml(o.order_no)} · ${escapeHtml(o.customer_name || '顾客')}</h3><span class="pill">${escapeHtml(statusName(o.status))}</span></div><p class="muted">顾客电话：${escapeHtml(o.customer_phone || '未提供')} · ${new Date(o.created_at).toLocaleString()} · ${escapeHtml(o.pickup_note || '未提供取货时间')}</p><p class="muted">备注：${escapeHtml(o.customer_note || '无')}</p>${(o.order_items||[]).map((line) => `<div class="ownerline" data-line="${line.id}" data-unit="${escapeHtml(line.unit)}" data-custom="${line.is_custom}"><strong>${escapeHtml(line.product_name)}<small>顾客要求：${escapeHtml(requestLabel(line))}</small></strong><select data-availability><option value="pending" ${line.availability==='pending'?'selected':''}>待确认</option><option value="available" ${line.availability==='available'?'selected':''}>有货</option><option value="unavailable" ${line.availability==='unavailable'?'selected':''}>缺货</option></select><input type="number" min="0" step="1" data-final-qty value="${escapeHtml(line.final_quantity ?? '')}" placeholder="实称克数/数量"><input type="number" min="0" step="0.01" data-final-price value="${escapeHtml(line.is_custom ? line.final_amount ?? '' : line.final_unit_price ?? '')}" placeholder="${line.is_custom ? '最终金额 RM' : line.unit==='公斤' ? 'RM/公斤' : 'RM/单位'}"></div>`).join('')}${['submitted','owner_review','customer_requested_change'].includes(o.status) ? `<button data-publish="${o.id}">计算并发给顾客确认</button>` : ''}${o.status==='confirmed' ? `<button data-fulfill="${o.id}">标记已备货/完成</button>` : ''}<div class="status" data-order-status></div></article>`).join('') : '<p class="muted">目前没有待处理订单。</p>';
}

$('#owner-orders').addEventListener('click', async (event) => {
  const fulfilled = event.target.closest('[data-fulfill]');
  if (fulfilled) {
    const { error } = await supabase.rpc('owner_mark_fulfilled', { target_order: fulfilled.dataset.fulfill });
    if (error) alert(`更新失败：${error.message}`); else await loadOwnerOrders();
    return;
  }
  const button = event.target.closest('[data-publish]'); if (!button) return;
  const card = button.closest('[data-owner-order]');
  const lines = [...card.querySelectorAll('[data-line]')].map((row) => ({
    id: row.dataset.line,
    availability: row.querySelector('[data-availability]').value,
    final_quantity: row.querySelector('[data-final-qty]').value,
    final_unit_price: row.dataset.custom === 'true' ? '' : row.querySelector('[data-final-price]').value,
    manual_amount: row.dataset.custom === 'true' ? row.querySelector('[data-final-price]').value : ''
  }));
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

