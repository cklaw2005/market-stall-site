alter table public.orders
  add column if not exists parent_order_id uuid references public.orders(id),
  add column if not exists parent_order_no text not null default '',
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancel_decided_at timestamptz,
  add column if not exists cancel_approved boolean;

create or replace function public.submit_addon_order(target_restaurant uuid, customer_name text, customer_phone text, pickup_note text, customer_note text, items jsonb, target_parent uuid)
returns table(id uuid, order_no text) language plpgsql security definer set search_path=public,auth
as $$
declare parent public.orders; created public.orders; created_id uuid; created_order_no text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into parent from public.orders o where o.id=target_parent and o.restaurant_id=target_restaurant and o.customer_id=auth.uid() for update;
  if parent.id is null then raise exception 'Original order not found'; end if;
  if parent.status not in ('submitted','owner_review','awaiting_customer_confirmation','customer_requested_change','confirmed') or parent.cancel_requested_at is not null then raise exception 'Original order is not open for add-ons'; end if;
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
