-- Store equal-portion packing requests separately from quantities and prices.
alter table public.order_items
  add column if not exists split_count integer;

alter table public.order_items
  drop constraint if exists order_items_split_count_check;

alter table public.order_items
  add constraint order_items_split_count_check
  check (split_count is null or split_count >= 2);

