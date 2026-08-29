/**
 * SDK worker host entry (spec §3.1): runs the CoverageEngine off the main
 * thread so the viewport stays interactive during compute.
 *
 * The public VisibilityEngine interface has no warning channel, so
 * CAMERA_INSIDE_GEOMETRY (spec §11) is forwarded to the main thread as a
 * side-channel 'warning' message over the same transport.
 *
 * `retainChunks` keeps each run's per-voxel masks **here** (SDK spec §16.1), so
 * the main thread never receives a `ChunkResult` at all. It asks for derived
 * quantities through the aggregation descriptor of spec §3.3 instead, and a
 * descriptor edit re-reduces these retained masks through
 * `WorkerClient.aggregateRetained` rather than paying a recompute.
 *
 * Retention is affordable because it holds the *compressed* form: measured at
 * 2.7–5.0 bytes per voxel on a cluttered scene, and 0.005 on a large sparse
 * site — tens of MiB, not the hundreds a dense form would take (SDK §9.5).
 */
import { installHost, messageTransport } from '@linkervision/camera-coverage-sdk';

const transport = messageTransport(self as unknown as Parameters<typeof messageTransport>[0]);

installHost(transport, {
  retainChunks: true,
  engineOptions: {
    onWarning: (code, message, detail) => {
      transport.post({ kind: 'warning', code, message, detail });
    },
  },
});
