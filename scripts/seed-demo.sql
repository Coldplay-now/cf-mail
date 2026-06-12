-- Demo data for local development / screenshots:
--   wrangler d1 execute cf-mail --local --file=schema.sql
--   wrangler d1 execute cf-mail --local --file=scripts/seed-demo.sql

INSERT OR IGNORE INTO addresses (id, address, display_name, active) VALUES
  ('a1', 'hello', 'Hello Desk', 1),
  ('a2', 'bot', 'CI Bot', 1),
  ('a3', 'legacy', NULL, 0);

INSERT OR IGNORE INTO mails (id, direction, status, message_id, thread_key, from_addr, from_name, to_addr, subject, text_body, html_body, snippet, read, created_at) VALUES
  ('m1', 'in', 'received', '<w1@github.example>', '<w1@github.example>',
   'notifications@github.example', 'GitHub', 'hello@example.com',
   '[cf-mail] Run #128 succeeded: deploy',
   'Deploy finished in 41s.\n\nView the run: https://github.example/runs/128',
   NULL, 'Deploy finished in 41s. View the run…', 0, datetime('now', '-23 minutes')),

  ('m2', 'in', 'received', '<n2@news.example>', '<n2@news.example>',
   'weekly@runtime.example', 'Runtime Weekly', 'hello@example.com',
   'Issue #87: Workers, D1 and the case for boring infrastructure',
   NULL,
   '<h2 style="margin:0 0 8px">Runtime Weekly #87</h2><p>This week: why the most interesting serverless story of the year is <b>email</b>, a deep dive on D1 read replication, and the boring-infrastructure manifesto.</p><ul><li>Email Routing + Workers, end to end</li><li>D1 point-in-time recovery in practice</li><li>R2 event notifications, finally</li></ul><p style="color:#888">You are receiving this because you subscribed.</p>',
   'This week: why the most interesting serverless story of the year is email…', 0, datetime('now', '-2 hours')),

  ('m3', 'in', 'received', '<q3@alice.example>', '<q3@alice.example>',
   'alice@fastmail.example', 'Alice Chen', 'hello@example.com',
   'Quick question about the blocklist design',
   'Hey!\n\nRead your post about moving mail onto Workers. One thing I could not figure out: when you block a sender, do existing messages get reclassified too, or only new ones?\n\nAlice',
   NULL, 'Hey! Read your post about moving mail onto Workers. One thing I could not…', 1, datetime('now', '-1 day')),

  ('m4', 'out', 'sent', NULL, '<q3@alice.example>',
   'hello@example.com', 'Hello Desk', 'alice@fastmail.example',
   'Re: Quick question about the blocklist design',
   'Both! Blocking does a retro-sweep: existing inbox mail from that sender is reclassified as spam in the same write. New mail is tagged at ingestion time and never triggers forwards or notifications.',
   NULL, 'Both! Blocking does a retro-sweep: existing inbox mail from that sender is…', 1, datetime('now', '-22 hours')),

  ('m5', 'in', 'received', '<r5@r2.example>', '<r5@r2.example>',
   'no-reply@statuspage.example', 'StatusPage', 'bot@example.com',
   'Monitor recovered: api.example.com',
   'The monitor api.example.com recovered at 09:14 UTC after 3m 12s of downtime.',
   NULL, 'The monitor api.example.com recovered at 09:14 UTC after 3m 12s…', 1, datetime('now', '-3 days')),

  ('m6', 'in', 'received', '<s6@spam.example>', '<s6@spam.example>',
   'winner@lottery.example', NULL, 'hello@example.com',
   'You have WON $4,500,000 USD!!!',
   'Claim your prize now by replying with your bank details.',
   NULL, 'Claim your prize now by replying with your bank details.', 1, datetime('now', '-4 days'));

UPDATE mails SET spam = 1 WHERE id = 'm6';

INSERT OR IGNORE INTO contacts (address, name, blocked) VALUES
  ('alice@fastmail.example', 'Alice Chen', 0),
  ('winner@lottery.example', NULL, 1);
