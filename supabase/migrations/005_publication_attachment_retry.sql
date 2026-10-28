-- Reservations are the durable attachment outbox, including older handoffs that
-- crashed before their provider ledger existed. Backoff survives stateless hosts.
alter table private.publication_reservations add column attachment_retry_at timestamptz;
create index publication_attachment_due on private.publication_reservations(attachment_retry_at,created_at)
 where resolution is null;
