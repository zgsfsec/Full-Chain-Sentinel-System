-- Match the console's source filter and stable timestamp/id cursor ordering.
CREATE INDEX idx_flows_source_order ON flows(source, ts DESC, id DESC);
CREATE INDEX idx_blobs_unused ON blobs(sha256) WHERE refcount = 0;
