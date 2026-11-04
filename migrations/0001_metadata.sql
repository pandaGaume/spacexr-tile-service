PRAGMA foreign_keys = ON;
CREATE TABLE service_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL);
CREATE TABLE tenants (id TEXT PRIMARY KEY, storage_limit INTEGER NOT NULL, object_limit INTEGER NOT NULL, job_limit INTEGER NOT NULL);
CREATE TABLE api_tokens (hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), subject TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE layers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, body_id TEXT, frame_id TEXT, visibility TEXT NOT NULL CHECK(visibility IN ('public','private')), status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, publish_sequence INTEGER NOT NULL DEFAULT 0, active_sequence INTEGER NOT NULL DEFAULT 0, active_revision TEXT, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, CHECK((body_id IS NULL) <> (frame_id IS NULL)));
CREATE INDEX layers_owner ON layers(tenant_id,id);
CREATE TABLE assets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, expected_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, content_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'quarantined', object_key TEXT NOT NULL, canonical_key TEXT, metadata TEXT, created_at INTEGER NOT NULL, error TEXT);
CREATE INDEX assets_owner ON assets(tenant_id,id);
CREATE TABLE objects (id TEXT PRIMARY KEY, layer_id TEXT NOT NULL REFERENCES layers(id), tenant_id TEXT NOT NULL REFERENCES tenants(id), asset_id TEXT NOT NULL REFERENCES assets(id), version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX objects_layer ON objects(layer_id,tenant_id,id);
CREATE TRIGGER asset_quota BEFORE INSERT ON assets BEGIN
 SELECT CASE WHEN COALESCE((SELECT SUM(byte_length) FROM assets WHERE tenant_id=NEW.tenant_id AND status IN ('quarantined','validating','ready')),0)+NEW.byte_length > (SELECT storage_limit FROM tenants WHERE id=NEW.tenant_id) THEN RAISE(ABORT,'TENANT_STORAGE_QUOTA') END;
END;
CREATE TRIGGER object_quota BEFORE INSERT ON objects BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM objects WHERE layer_id=NEW.layer_id)>=(SELECT object_limit FROM tenants WHERE id=NEW.tenant_id) THEN RAISE(ABORT,'LAYER_OBJECT_QUOTA') END;
END;
CREATE TRIGGER object_insert AFTER INSERT ON objects BEGIN UPDATE layers SET version=version+1,status='draft' WHERE id=NEW.layer_id; END;
CREATE TRIGGER object_update AFTER UPDATE ON objects BEGIN UPDATE layers SET version=version+1,status='draft' WHERE id=NEW.layer_id; END;
CREATE TRIGGER object_delete AFTER DELETE ON objects BEGIN UPDATE layers SET version=version+1,status='draft' WHERE id=OLD.layer_id; END;
CREATE TABLE jobs (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),kind TEXT NOT NULL,resource_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',payload TEXT NOT NULL,lease_token TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX jobs_claim ON jobs(status,lease_until,created_at);
CREATE TRIGGER job_quota BEFORE INSERT ON jobs BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM jobs WHERE tenant_id=NEW.tenant_id AND status IN ('queued','running'))>=(SELECT job_limit FROM tenants WHERE id=NEW.tenant_id) THEN RAISE(ABORT,'ACTIVE_JOB_QUOTA') END;
END;
CREATE TABLE outbox (job_id TEXT PRIMARY KEY REFERENCES jobs(id),sent_at INTEGER);
CREATE TABLE revisions (id TEXT PRIMARY KEY,layer_id TEXT NOT NULL REFERENCES layers(id),tenant_id TEXT NOT NULL REFERENCES tenants(id),sequence INTEGER NOT NULL,source_version INTEGER NOT NULL,visibility TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'staging',root_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(layer_id,sequence));
CREATE TABLE datasets (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),body_id TEXT NOT NULL,revision TEXT NOT NULL,visibility TEXT NOT NULL,manifest TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE audit_log (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,subject TEXT NOT NULL,operation TEXT NOT NULL,resource_id TEXT,created_at INTEGER NOT NULL);
CREATE TABLE idempotency (tenant_id TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,input_hash TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,operation,key));

CREATE TABLE publication_counters (kind TEXT NOT NULL,resource_id TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,resource_id));
