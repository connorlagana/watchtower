-- Usage history for the /stats page. Days are UTC.
--
-- usage_daily: one row per client, day, tool and interface, so distinct clients per day (daily active users),
-- calls per tool and retention can be counted. client_id is deliberately not a foreign key: the history
-- outlives clients that maintenance deletes.
CREATE TABLE usage_daily (
  day        date NOT NULL,
  client_id  uuid NOT NULL,
  tool       text NOT NULL,              -- watch_jobs | get_changes | list_watches | get_watch | ack_changes | delete_watch | check_now
  via        text NOT NULL CHECK (via IN ('mcp', 'rest')),
  calls      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, client_id, tool, via)
);
CREATE INDEX usage_daily_client_idx ON usage_daily (client_id, day);

-- counts_daily: anonymous daily counters, e.g. ('page_view', '/llms.txt|ai') or ('mcp_connect', 'claude-code').
CREATE TABLE counts_daily (
  day     date NOT NULL,
  metric  text NOT NULL,
  dim     text NOT NULL,
  n       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, dim)
);
