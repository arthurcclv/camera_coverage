/**
 * SDK worker host entry (spec §3.1): runs the CoverageEngine off the main
 * thread so the viewport stays interactive during compute.
 *
 * The public VisibilityEngine interface has no warning channel, so
 * CAMERA_INSIDE_GEOMETRY (spec §11) is forwarded to the main thread as a
 * side-channel 'warning' message over the same transport.
 */
import { installHost, messageTransport } from '@linkervision/camera-coverage-sdk';

const transport = messageTransport(self as unknown as Parameters<typeof messageTransport>[0]);

installHost(transport, {
  engineOptions: {
    onWarning: (code, message, detail) => {
      transport.post({ kind: 'warning', code, message, detail });
    },
  },
});
