-- Raise the customer menu preference limit from 10 to 40.
alter table public.profiles
  drop constraint if exists profiles_preferred_product_keys_check;

alter table public.profiles
  add constraint profiles_preferred_product_keys_check
  check (cardinality(preferred_product_keys) <= 40);

