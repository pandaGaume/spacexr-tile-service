CREATE TABLE dataset_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  body_id TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  source TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX dataset_drafts_owner ON dataset_drafts(tenant_id,id);
CREATE INDEX jobs_owner ON jobs(tenant_id,id);
CREATE INDEX audit_owner ON audit_log(tenant_id,id);
CREATE INDEX tokens_owner ON api_tokens(tenant_id,hash);
