import type {
  CaptureProfile,
  ProfilerInit,
  ProfilerSession,
} from "../lib/perf/js-self-profile.contract";

declare global {
  var Profiler: { new (init: ProfilerInit): ProfilerSession };
  interface Window {
    __jsProfile?: CaptureProfile;
  }
}
