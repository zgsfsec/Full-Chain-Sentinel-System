package store

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
)

func TestCaptureCleanupReclaimsOnlyUnreferencedFiles(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	shared := []byte("shared with replay and artifact")
	unique := []byte("only captured")
	proxy := &Flow{Source: "proxy", Method: "GET", Scheme: "http", Host: "test", Path: "/", ReqRaw: shared, RespRaw: unique}
	replay := &Flow{Source: "replay", Method: "GET", Scheme: "http", Host: "test", Path: "/", ReqRaw: shared}
	for _, flow := range []*Flow{proxy, replay} {
		if err := s.InsertFlow(ctx, flow); err != nil {
			t.Fatal(err)
		}
	}
	artifact := &Artifact{Kind: ArtifactText}
	if err := s.InsertArtifact(ctx, artifact, shared); err != nil {
		t.Fatal(err)
	}
	deleted, err := s.DeleteProxyFlows(ctx, []string{proxy.ID, replay.ID, proxy.ID, "missing"})
	if err != nil || deleted != 1 {
		t.Fatalf("deleted=%d err=%v", deleted, err)
	}
	if _, err := os.Stat(s.blobs.path(sha256Hex(unique))); !os.IsNotExist(err) {
		t.Fatalf("unused blob still exists: %v", err)
	}
	got, err := s.GetFlow(ctx, replay.ID, true)
	if err != nil || string(got.ReqRaw) != string(shared) {
		t.Fatalf("replay damaged: %v", err)
	}
	_, data, err := s.GetArtifact(ctx, artifact.ID)
	if err != nil || string(data) != string(shared) {
		t.Fatalf("artifact damaged: %v", err)
	}
	var refs int
	if err := s.db.QueryRow("SELECT refcount FROM blobs WHERE sha256 = ?", sha256Hex(shared)).Scan(&refs); err != nil || refs != 2 {
		t.Fatalf("references=%d err=%v", refs, err)
	}
	if err := s.DeleteFlow(ctx, replay.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteArtifact(ctx, artifact.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteProxyFlows(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.blobs.path(sha256Hex(shared))); !os.IsNotExist(err) {
		t.Fatalf("unreferenced shared blob remains: %v", err)
	}
}

func TestCaptureCleanupRollsBackOnFailure(t *testing.T) {
	s := newTestStore(t)
	f := &Flow{Source: "proxy", Method: "GET", Scheme: "http", Host: "test", Path: "/", RespRaw: []byte("keep")}
	if err := s.InsertFlow(t.Context(), f); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON flows BEGIN SELECT RAISE(ABORT, 'fixture'); END"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteProxyFlows(t.Context(), nil); err == nil {
		t.Fatal("expected rollback")
	}
	got, err := s.GetFlow(t.Context(), f.ID, true)
	if err != nil || string(got.RespRaw) != "keep" {
		t.Fatalf("rollback lost data: %v", err)
	}
	var refs int
	if err := s.db.QueryRow("SELECT refcount FROM blobs WHERE sha256 = ?", sha256Hex(f.RespRaw)).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("references=%d err=%v", refs, err)
	}
	s.db.Exec("DROP TRIGGER reject_cleanup")
	if _, err := s.DeleteProxyFlows(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
}

func TestCaptureCleanupCoordinatesConcurrentInserts(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	for round := 0; round < 20; round++ {
		payload := []byte(fmt.Sprintf("shared-%d", round))
		old := &Flow{Source: "proxy", Method: "GET", Host: "test", Path: "/", RespRaw: payload}
		if err := s.InsertFlow(ctx, old); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		errors := make(chan error, 3)
		wg.Add(3)
		go func() { defer wg.Done(); _, err := s.DeleteProxyFlows(ctx, nil); errors <- err }()
		replay := &Flow{Source: "replay", Method: "GET", Host: "test", Path: "/", RespRaw: payload}
		artifact := &Artifact{Kind: ArtifactText}
		go func() { defer wg.Done(); errors <- s.InsertFlow(ctx, replay) }()
		go func() { defer wg.Done(); errors <- s.InsertArtifact(ctx, artifact, payload) }()
		wg.Wait()
		close(errors)
		for err := range errors {
			if err != nil {
				t.Fatal(err)
			}
		}
		got, err := s.GetFlow(ctx, replay.ID, true)
		if err != nil || string(got.RespRaw) != string(payload) {
			t.Fatalf("concurrent replay damaged: %v", err)
		}
		_, data, err := s.GetArtifact(ctx, artifact.ID)
		if err != nil || string(data) != string(payload) {
			t.Fatalf("concurrent artifact damaged: %v", err)
		}
	}
}

func TestCleanupBatchesPreserveNewCapturesAndSharedEvidence(t *testing.T) {
	s := newTestStore(t)
	ctx := t.Context()
	for i := 0; i < 600; i++ {
		f := &Flow{Source: "proxy", Method: "GET", Host: "test", Path: "/", RespRaw: []byte("shared")}
		if err := s.InsertFlow(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	var through int64
	if err := s.db.QueryRow("SELECT MAX(rowid) FROM flows").Scan(&through); err != nil {
		t.Fatal(err)
	}
	deleted, after, err := s.deleteProxyBatch(ctx, nil, 0, through)
	if err != nil || deleted != 256 {
		t.Fatalf("first batch=%d err=%v", deleted, err)
	}
	// An old timestamp must not cause a newly inserted capture to be removed.
	newFlow := &Flow{Source: "proxy", Method: "GET", Host: "test", Path: "/new", TS: 1, RespRaw: []byte("shared")}
	if err := s.InsertFlow(ctx, newFlow); err != nil {
		t.Fatal(err)
	}
	for {
		n, last, err := s.deleteProxyBatch(ctx, nil, after, through)
		if err != nil {
			t.Fatal(err)
		}
		deleted += n
		if n == 0 {
			break
		}
		after = last
	}
	if deleted != 600 {
		t.Fatalf("deleted=%d want 600", deleted)
	}
	if _, err := s.collectUnusedBlobBatch(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetFlow(ctx, newFlow.ID, true)
	if err != nil || string(got.RespRaw) != "shared" {
		t.Fatalf("new capture damaged: %v", err)
	}
	var refs int
	if err := s.db.QueryRow("SELECT refcount FROM blobs WHERE sha256 = ?", sha256Hex([]byte("shared"))).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("refs=%d err=%v", refs, err)
	}
	// Completing the last old batch must not remove a new row reusing its rowid.
	if _, err := s.DeleteProxyFlows(ctx, nil); err != nil {
		t.Fatal(err)
	}
	reused := &Flow{Source: "proxy", Method: "GET", Host: "test", Path: "/reused"}
	if err := s.InsertFlow(ctx, reused); err != nil {
		t.Fatal(err)
	}
	if n, _, err := s.deleteProxyBatch(ctx, nil, after, through); err != nil || n != 0 {
		t.Fatalf("reused row deleted: n=%d err=%v", n, err)
	}
}

func TestCleanupCancellationRetainsUnprocessedBatches(t *testing.T) {
	s := newTestStore(t)
	f := &Flow{Source: "proxy", Method: "GET", Host: "test", Path: "/", RespRaw: []byte("keep")}
	if err := s.InsertFlow(t.Context(), f); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.DeleteProxyFlows(ctx, nil); err == nil {
		t.Fatal("expected cancellation")
	}
	got, err := s.GetFlow(t.Context(), f.ID, true)
	if err != nil || string(got.RespRaw) != "keep" {
		t.Fatalf("capture lost on cancellation: %v", err)
	}
}
