create extension if not exists pg_cron;

select cron.schedule(
  'ai-memory-free-decay',
  '0 3 * * *',
  $$
    update public.memories
    set importance = importance * 0.95
    where is_active
      and coalesce(last_accessed_at, created_at) < now() - interval '30 days'
      and importance > 0.1;
  $$
);

select cron.schedule(
  'ai-memory-free-expire',
  '0 4 * * *',
  $$
    update public.memories
    set is_active = false,
        metadata = metadata || jsonb_build_object('expired_at', now(), 'expired_by', 'ai-memory-free-expire')
    where is_active
      and importance < 0.1
      and access_count = 0
      and created_at < now() - interval '90 days';
  $$
);
