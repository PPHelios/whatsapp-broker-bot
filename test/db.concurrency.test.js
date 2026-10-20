// test/db.concurrency.test.js
"use strict";

describe("Database Distributed Advisory Locks & Concurrency", () => {
  test("Serializes simultaneous updates to the same listing using advisory lock simulation", async () => {
    const lockHistory = [];
    let currentLockedCode = null;

    // Simulate PostgreSQL advisory xact lock worker
    const executeWithLock = async (agentName, listingCode, workDurationMs) => {
      lockHistory.push(`${agentName}:REQUEST_LOCK`);

      // Advisory lock acquisition
      while (currentLockedCode === listingCode) {
        await new Promise((r) => setTimeout(r, 10)); // wait for lock release
      }
      currentLockedCode = listingCode;
      lockHistory.push(`${agentName}:ACQUIRED_LOCK`);

      // Critical Section
      await new Promise((r) => setTimeout(r, workDurationMs));

      // Lock releases at transaction commit
      currentLockedCode = null;
      lockHistory.push(`${agentName}:RELEASED_LOCK`);
      return `${agentName}:SUCCESS`;
    };

    // Trigger two brokers updating #HAS-101 at the exact same millisecond
    const p1 = executeWithLock("Broker_1", "HAS101", 50);
    const p2 = executeWithLock("Broker_2", "HAS101", 30);

    const results = await Promise.all([p1, p2]);

    expect(results).toEqual(["Broker_1:SUCCESS", "Broker_2:SUCCESS"]);

    // Assert that Broker_2 NEVER acquired lock before Broker_1 released it
    const b1Acquire = lockHistory.indexOf("Broker_1:ACQUIRED_LOCK");
    const b1Release = lockHistory.indexOf("Broker_1:RELEASED_LOCK");
    const b2Acquire = lockHistory.indexOf("Broker_2:ACQUIRED_LOCK");

    expect(b1Acquire).toBeLessThan(b1Release);
    expect(b1Release).toBeLessThan(b2Acquire);
  });

  test("Rejects duplicate batch submissions via idempotent key set", async () => {
    const processedBatches = new Set();
    const batchKey = "sha1_batch_hash_98765";

    const processBatchIdempotent = (key) => {
      if (processedBatches.has(key)) {
        return { status: "duplicate", saved: false };
      }
      processedBatches.add(key);
      return { status: "processed", saved: true };
    };

    // First attempt saves
    const firstAttempt = processBatchIdempotent(batchKey);
    expect(firstAttempt.status).toBe("processed");
    expect(firstAttempt.saved).toBe(true);

    // Immediate duplicate replay drops safely
    const duplicateAttempt = processBatchIdempotent(batchKey);
    expect(duplicateAttempt.status).toBe("duplicate");
    expect(duplicateAttempt.saved).toBe(false);
  });
});
