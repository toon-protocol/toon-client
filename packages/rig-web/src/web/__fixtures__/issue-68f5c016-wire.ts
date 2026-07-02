/**
 * Real wire capture from wss://relay-ws.devnet.toonprotocol.dev (2026-07-02).
 *
 * The kind:1621 issue event 68f5c016… for repo hello-compare-rig, exactly as
 * served by the devnet relay. The payload is byte-identical to canonical
 * @toon-format/toon encode() output, yet decode() rejects it (quoted scalar
 * containing an inline-array-header-shaped substring, e.g. argv[2] plus a
 * later colon). This is the exact payload the Issues tab silently dropped
 * in toon-client#276.
 */

/** The raw WebSocket frame as received (JSON array message). */
export const ISSUE_68F5C016_WIRE_FRAME = "[\"EVENT\",\"cap1\",\"id: 68f5c016e5a3128d7af740e088fc5d94e56edda4205fffa56aa3d58fe6bb55ee\\npubkey: 3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5\\nkind: 1621\\ncontent: \\\"Currently index.js always prints \\\\\\\"Hello, world!\\\\\\\". It should accept an optional name as the first CLI argument (process.argv[2]) and greet that name instead, falling back to \\\\\\\"world\\\\\\\" when no argument is given. Example: `node index.js Ada` -> \\\\\\\"Hello, Ada!\\\\\\\".\\\"\\ntags[4]:\\n  - [2]: a,\\\"30617:3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5:hello-compare-rig\\\"\\n  - [2]: p,3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5\\n  - [2]: subject,greeting should accept a name argument\\n  - [2]: t,enhancement\\ncreated_at: 1783027036\\nsig: 3220fa9dcb7af14b9a970f5d25f4ac13ebb4848c91a83bf496cdef17a839d4475773defb38a20d64b250227eb5aa457eb77358c5f32c4c7935397a3430b102db\"]";

/** The EVENT payload (frame[2]): the TOON-serialized event. */
export const ISSUE_68F5C016_WIRE_PAYLOAD = "id: 68f5c016e5a3128d7af740e088fc5d94e56edda4205fffa56aa3d58fe6bb55ee\npubkey: 3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5\nkind: 1621\ncontent: \"Currently index.js always prints \\\"Hello, world!\\\". It should accept an optional name as the first CLI argument (process.argv[2]) and greet that name instead, falling back to \\\"world\\\" when no argument is given. Example: `node index.js Ada` -> \\\"Hello, Ada!\\\".\"\ntags[4]:\n  - [2]: a,\"30617:3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5:hello-compare-rig\"\n  - [2]: p,3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5\n  - [2]: subject,greeting should accept a name argument\n  - [2]: t,enhancement\ncreated_at: 1783027036\nsig: 3220fa9dcb7af14b9a970f5d25f4ac13ebb4848c91a83bf496cdef17a839d4475773defb38a20d64b250227eb5aa457eb77358c5f32c4c7935397a3430b102db";
