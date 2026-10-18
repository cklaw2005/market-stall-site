-- Phase 2: website-first multi-restaurant ordering.
-- Run in the Supabase SQL Editor after creating the project.
create extension if not exists pgcrypto;

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  phone text not null default '',
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  role text not null default 'customer' check (role in ('owner','manager','customer')),
  customer_slot integer check (customer_slot > 0),
  preferred_product_keys text[] not null default '{}' check (cardinality(preferred_product_keys)<=40),
  active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now()
);

drop index if exists public.profiles_active_customer_slot_unique;
create unique index if not exists profiles_customer_slot_unique on public.profiles(restaurant_id,customer_slot)
  where role='customer' and customer_slot is not null;

create table if not exists public.restaurant_memberships (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','manager')),
  created_at timestamptz not null default now(),
  primary key (restaurant_id,user_id)
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  product_key text not null,
  name_zh text not null,
  name_en text not null default '',
  category text not null default '',
  unit text not null default '公斤',
  unit_price numeric(10,2),
  active boolean not null default true,
  display_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (restaurant_id,product_key)
);

create table if not exists public.customer_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  product_key text not null,
  mode text not null check (mode in ('weight','money','count')),
  usual_amount numeric(10,2) not null check (usual_amount > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id,restaurant_id,product_key)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique default ('MK-' || to_char(now() at time zone 'Asia/Kuala_Lumpur','YYMMDD') || '-' || upper(substr(encode(gen_random_bytes(4),'hex'),1,6))),
  restaurant_id uuid not null references public.restaurants(id),
  customer_id uuid not null references auth.users(id),
  customer_phone text not null default '',
  customer_name text not null default '',
  pickup_note text not null default '',
  customer_note text not null default '',
  parent_order_id uuid references public.orders(id),
  parent_order_no text not null default '',
  cancel_requested_at timestamptz,
  cancel_decided_at timestamptz,
  cancel_approved boolean,
  status text not null default 'submitted' check (status in ('submitted','owner_review','awaiting_customer_confirmation','customer_requested_change','confirmed','fulfilled','cancelled')),
  confirmed_revision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_key text,
  product_name text not null,
  unit text not null default '公斤',
  request_mode text not null check (request_mode in ('weight','money','count','custom')),
  requested_amount numeric(10,2) not null check (requested_amount > 0),
  requested_unit_price numeric(10,2),
  split_count integer check (split_count is null or split_count >= 2),
  is_custom boolean not null default false,
  availability text not null default 'pending' check (availability in ('pending','available','unavailable')),
  final_quantity numeric(10,3),
  final_unit_price numeric(10,2),
  final_amount numeric(10,2),
  created_at timestamptz not null default now()
);

create table if not exists public.order_revisions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  revision_no integer not null,
  lines jsonb not null,
  total numeric(10,2) not null check (total >= 0),
  proposed_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (order_id,revision_no)
);

create index if not exists orders_customer_created_idx on public.orders(customer_id,created_at desc);
create index if not exists orders_restaurant_status_idx on public.orders(restaurant_id,status,created_at desc);
create index if not exists order_items_order_idx on public.order_items(order_id);

create or replace function public.is_restaurant_member(target_restaurant uuid)
returns boolean language sql stable security definer set search_path=public,auth
as $$ select exists(select 1 from public.restaurant_memberships m where m.restaurant_id=target_restaurant and m.user_id=auth.uid()); $$;

create or replace function public.is_active_customer(target_restaurant uuid)
returns boolean language sql stable security definer set search_path=public,auth
as $$ select exists(select 1 from public.profiles p where p.user_id=auth.uid() and p.restaurant_id=target_restaurant and p.role='customer' and p.active and not p.must_change_password); $$;

create or replace function public.can_access_order(target_order uuid)
returns boolean language sql stable security definer set search_path=public,auth
as $$ select exists(select 1 from public.orders o where o.id=target_order and ((o.customer_id=auth.uid() and public.is_active_customer(o.restaurant_id)) or public.is_restaurant_member(o.restaurant_id))); $$;

alter table public.restaurants enable row level security;
alter table public.profiles enable row level security;
alter table public.restaurant_memberships enable row level security;
alter table public.menu_items enable row level security;
alter table public.customer_preferences enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_revisions enable row level security;

drop policy if exists restaurants_public_read on public.restaurants;
create policy restaurants_public_read on public.restaurants for select using (active);
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles for select using (user_id=auth.uid());
drop policy if exists profiles_owner_read_customers on public.profiles;
create policy profiles_owner_read_customers on public.profiles for select using (role='customer' and public.is_restaurant_member(restaurant_id));
drop policy if exists profiles_self_write on public.profiles;
-- Profiles are provisioned by the trusted customer-admin Edge Function, never by browser writes.
drop policy if exists memberships_self_read on public.restaurant_memberships;
create policy memberships_self_read on public.restaurant_memberships for select using (user_id=auth.uid());
drop policy if exists menu_public_read on public.menu_items;
create policy menu_public_read on public.menu_items for select using (active);
drop policy if exists menu_owner_write on public.menu_items;
create policy menu_owner_write on public.menu_items for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
drop policy if exists preferences_self on public.customer_preferences;
create policy preferences_self on public.customer_preferences for all using (user_id=auth.uid() and public.is_active_customer(restaurant_id)) with check (user_id=auth.uid() and public.is_active_customer(restaurant_id));
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select using ((customer_id=auth.uid() and public.is_active_customer(restaurant_id)) or public.is_restaurant_member(restaurant_id));
drop policy if exists orders_customer_insert on public.orders;
drop policy if exists orders_owner_update on public.orders;
create policy orders_owner_update on public.orders for update using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
drop policy if exists order_items_read on public.order_items;
create policy order_items_read on public.order_items for select using (public.can_access_order(order_id));
drop policy if exists order_items_customer_insert on public.order_items;
drop policy if exists order_items_owner_update on public.order_items;
create policy order_items_owner_update on public.order_items for update using (exists(select 1 from public.orders o where o.id=order_id and public.is_restaurant_member(o.restaurant_id))) with check (exists(select 1 from public.orders o where o.id=order_id and public.is_restaurant_member(o.restaurant_id)));
drop policy if exists revisions_read on public.order_revisions;
create policy revisions_read on public.order_revisions for select using (public.can_access_order(order_id));
drop policy if exists revisions_owner_insert on public.order_revisions;

create or replace function public.submit_order(target_restaurant uuid, customer_name text, customer_phone text, pickup_note text, customer_note text, items jsonb)
returns table(id uuid, order_no text) language plpgsql security definer set search_path=public,auth
as $$
declare created_order public.orders; inserted_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists(select 1 from public.profiles p where p.user_id=auth.uid() and p.restaurant_id=target_restaurant and p.role='customer' and p.active and not p.must_change_password) then raise exception 'Active customer account required'; end if;
  if not exists(select 1 from public.restaurants where restaurants.id=target_restaurant and active) then raise exception 'Restaurant unavailable'; end if;
  if jsonb_typeof(items)<>'array' or jsonb_array_length(items)<1 or jsonb_array_length(items)>100 then raise exception 'Invalid order items'; end if;
  insert into public.orders(restaurant_id,customer_id,customer_phone,customer_name,pickup_note,customer_note)
  values(target_restaurant,auth.uid(),left(coalesce(customer_phone,''),40),left(coalesce(customer_name,''),120),left(coalesce(pickup_note,''),200),left(coalesce(customer_note,''),1000))
  returning * into created_order;
  insert into public.order_items(order_id,product_key,product_name,unit,request_mode,requested_amount,requested_unit_price,split_count,is_custom)
  select created_order.id, nullif(x->>'product_key',''), left(coalesce(x->>'product_name',''),120), left(coalesce(x->>'unit',''),40),
    x->>'request_mode', (x->>'requested_amount')::numeric, nullif(x->>'requested_unit_price','')::numeric,
    nullif(x->>'split_count','')::integer, coalesce((x->>'is_custom')::boolean,false)
  from jsonb_array_elements(items) x
  where (x->>'requested_amount')::numeric>0 and x->>'request_mode' in ('weight','money','count','custom');
  get diagnostics inserted_count = row_count;
  if inserted_count<>jsonb_array_length(items) then raise exception 'One or more order lines are invalid'; end if;
  if not found then raise exception 'No valid order items'; end if;
  return query select created_order.id,created_order.order_no;
end; $$;
grant execute on function public.submit_order(uuid,text,text,text,text,jsonb) to authenticated;

create or replace function public.submit_addon_order(target_restaurant uuid, customer_name text, customer_phone text, pickup_note text, customer_note text, items jsonb, target_parent uuid)
returns table(id uuid, order_no text) language plpgsql security definer set search_path=public,auth
as $$
declare parent public.orders; created public.orders; created_id uuid; created_order_no text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into parent from public.orders o where o.id=target_parent and o.restaurant_id=target_restaurant and o.customer_id=auth.uid() for update;
  if parent.id is null then raise exception 'Original order not found'; end if;
  if parent.status not in ('submitted','owner_review','awaiting_customer_confirmation','customer_requested_change','confirmed') or (parent.cancel_requested_at is not null and parent.cancel_decided_at is null) then raise exception 'Original order is not open for add-ons'; end if;
  select s.id,s.order_no into created_id,created_order_no from public.submit_order(target_restaurant,customer_name,customer_phone,pickup_note,customer_note,items) s;
  update public.orders o set parent_order_id=parent.id,parent_order_no=parent.order_no where o.id=created_id and o.customer_id=auth.uid() returning o.* into created;
  if created.id is null then raise exception 'Could not link add-on order'; end if;
  id:=created.id; order_no:=created_order_no; return next;
end; $$;
grant execute on function public.submit_addon_order(uuid,text,text,text,text,jsonb,uuid) to authenticated;

create or replace function public.customer_request_order_cancel(target_order uuid)
returns void language plpgsql security definer set search_path=public,auth
as $$
declare current_order public.orders;
begin
  select * into current_order from public.orders o where o.id=target_order and o.customer_id=auth.uid() for update;
  if current_order.id is null or not public.is_active_customer(current_order.restaurant_id) then raise exception 'Order not found'; end if;
  if current_order.status not in ('submitted','owner_review','awaiting_customer_confirmation','customer_requested_change','confirmed') or current_order.cancel_requested_at is not null then raise exception 'Order cannot be cancelled in its current state'; end if;
  update public.orders set cancel_requested_at=now(),updated_at=now() where id=target_order;
end; $$;
grant execute on function public.customer_request_order_cancel(uuid) to authenticated;

create or replace function public.owner_decide_order_cancellation(target_order uuid, approve boolean)
returns void language plpgsql security definer set search_path=public,auth
as $$
declare order_restaurant uuid; requested_at timestamptz;
begin
  select restaurant_id,cancel_requested_at into order_restaurant,requested_at from public.orders where id=target_order for update;
  if order_restaurant is null or not public.is_restaurant_member(order_restaurant) then raise exception 'Not authorized for this restaurant'; end if;
  if requested_at is null or exists(select 1 from public.orders where id=target_order and cancel_decided_at is not null) then raise exception 'No pending cancellation request'; end if;
  update public.orders set status=case when approve then 'cancelled' else status end,cancel_decided_at=now(),cancel_approved=approve,updated_at=now() where id=target_order;
end; $$;
grant execute on function public.owner_decide_order_cancellation(uuid,boolean) to authenticated;

create or replace function public.owner_publish_revision(target_order uuid, lines jsonb)
returns table(revision_id uuid,total numeric,revision_no integer) language plpgsql security definer set search_path=public,auth
as $$
declare order_restaurant uuid; order_status text; new_revision integer; computed_total numeric(10,2); saved_lines jsonb; item_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select restaurant_id,status into order_restaurant,order_status from public.orders where id=target_order for update;
  if order_restaurant is null or not public.is_restaurant_member(order_restaurant) then raise exception 'Not authorized for this restaurant'; end if;
  if order_status not in ('submitted','owner_review','customer_requested_change') then raise exception 'Order is not open for changes'; end if;
  if exists(select 1 from public.orders where id=target_order and cancel_requested_at is not null and cancel_decided_at is null) then raise exception 'Order has a pending cancellation request'; end if;
  if jsonb_typeof(lines)<>'array' then raise exception 'Invalid final lines'; end if;
  select count(*) into item_count from public.order_items where order_id=target_order;
  if jsonb_array_length(lines)<>item_count then raise exception 'Every order item must be included'; end if;
  if (select count(distinct x->>'id') from jsonb_array_elements(lines) x)<>item_count then raise exception 'Each order item must be included once'; end if;
  with submitted as (
    select (x->>'id')::uuid as id, x->>'availability' as availability,
      nullif(x->>'final_quantity','')::numeric as final_quantity,
      nullif(x->>'final_unit_price','')::numeric as final_unit_price,
      nullif(x->>'manual_amount','')::numeric as manual_amount
    from jsonb_array_elements(lines) x
  ), calculated as (
    select oi.id, s.availability, s.final_quantity, s.final_unit_price, s.manual_amount,
      case when s.availability='unavailable' then 0
           when oi.is_custom then s.manual_amount
           when oi.unit in ('公斤','kg','KG') then round(s.final_quantity*s.final_unit_price/1000,2)
           else round(s.final_quantity*s.final_unit_price,2) end as final_amount
    from submitted s join public.order_items oi on oi.id=s.id and oi.order_id=target_order
  )
  select coalesce(sum(case when availability='unavailable' then 0 else final_amount end),0),
    jsonb_agg(jsonb_build_object('id',id,'availability',availability,'final_quantity',final_quantity,'final_unit_price',final_unit_price,'manual_amount',manual_amount,'final_amount',final_amount))
  into computed_total,saved_lines from calculated;
  if saved_lines is null or jsonb_array_length(saved_lines)<>item_count or exists(select 1 from jsonb_array_elements(saved_lines) l where l->>'availability' not in ('available','unavailable') or (l->>'availability'='available' and ((l->>'final_amount') is null or (l->>'final_amount')::numeric<0 or (case when nullif(l->>'manual_amount','') is not null then (l->>'manual_amount')::numeric<0 else coalesce((l->>'final_quantity')::numeric,0)<=0 or coalesce((l->>'final_unit_price')::numeric,-1)<0 end)))) then raise exception 'Complete availability, quantity, and final prices for every line'; end if;
  update public.order_items oi set availability=l->>'availability', final_quantity=nullif(l->>'final_quantity','')::numeric,
    final_unit_price=nullif(l->>'final_unit_price','')::numeric, final_amount=nullif(l->>'final_amount','')::numeric
    from jsonb_array_elements(saved_lines) l where oi.id=(l->>'id')::uuid and oi.order_id=target_order;
  select coalesce(max(r.revision_no),0)+1 into new_revision from public.order_revisions r where r.order_id=target_order;
  insert into public.order_revisions(order_id,revision_no,lines,total,proposed_by)
    values(target_order,new_revision,saved_lines,computed_total,auth.uid()) returning id into revision_id;
  update public.orders set status='awaiting_customer_confirmation',updated_at=now() where id=target_order;
  total:=computed_total; revision_no:=new_revision; return next;
end; $$;
grant execute on function public.owner_publish_revision(uuid,jsonb) to authenticated;

create or replace function public.owner_mark_fulfilled(target_order uuid)
returns void language plpgsql security definer set search_path=public,auth
as $$
declare order_restaurant uuid;
begin
  select restaurant_id into order_restaurant from public.orders where id=target_order for update;
  if order_restaurant is null or not public.is_restaurant_member(order_restaurant) then raise exception 'Not authorized for this restaurant'; end if;
  update public.orders set status='fulfilled',updated_at=now() where id=target_order and status='confirmed';
  if not found then raise exception 'Customer must confirm the latest order first'; end if;
end; $$;
grant execute on function public.owner_mark_fulfilled(uuid) to authenticated;

create or replace function public.customer_decide_order(target_order uuid,target_revision uuid,accept boolean)
returns void language plpgsql security definer set search_path=public,auth
as $$
declare owner_customer uuid;
begin
  select customer_id into owner_customer from public.orders where id=target_order for update;
  if owner_customer is null or owner_customer<>auth.uid() then raise exception 'Order not found'; end if;
  if not exists(select 1 from public.orders o where o.id=target_order and public.is_active_customer(o.restaurant_id)) then raise exception 'Active customer account required'; end if;
  if exists(select 1 from public.orders where id=target_order and cancel_requested_at is not null and cancel_decided_at is null) then raise exception 'Order has a pending cancellation request'; end if;
  if not exists(select 1 from public.order_revisions r where r.id=target_revision and r.order_id=target_order and r.revision_no=(select max(latest.revision_no) from public.order_revisions latest where latest.order_id=target_order)) then raise exception 'Revision not found'; end if;
  if (select status from public.orders where id=target_order)<>'awaiting_customer_confirmation' then raise exception 'Order is not awaiting confirmation'; end if;
  update public.orders set status=case when accept then 'confirmed' else 'customer_requested_change' end,
    confirmed_revision_id=case when accept then target_revision else null end, updated_at=now() where id=target_order;
end; $$;
grant execute on function public.customer_decide_order(uuid,uuid,boolean) to authenticated;

-- Create the initial stall record once. Provision the first owner membership manually in the SQL editor.
insert into public.restaurants(slug,name) values ('dad-vegetable-stall','爸爸的鲜菜摊') on conflict(slug) do nothing;
