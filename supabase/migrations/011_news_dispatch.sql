-- 011: the tick starts the GitHub news job itself (GitHub's own schedule started runs hours late or not at all).
-- github_token: a fine-grained token for RoglMarcel/iwt-social with "Actions: read and write".
alter table iwt.secrets add column github_token text;
alter table iwt.settings add column news_dispatched_at timestamptz;
