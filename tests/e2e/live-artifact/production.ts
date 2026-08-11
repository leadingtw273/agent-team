import {
  collectProductionLiveArtifact,
  type CollectProductionLiveArtifactInput,
  type ExternalAuthorityPorts,
} from "./collector.js";
import { replayLiveArtifact } from "./validator.js";
import { LiveArtifactWriter } from "./writer.js";

export type ProductionCaptureInput = Omit<CollectProductionLiveArtifactInput, "provenance"> &
  Readonly<{
    provenance: CollectProductionLiveArtifactInput["provenance"];
    artifactFileName: string;
    artifactRoot: string;
  }>;

/** The sole T11-facing capture path; it deliberately accepts no assembled evidence. */
export async function captureProductionLiveArtifact(
  input: ProductionCaptureInput,
  ports: ExternalAuthorityPorts,
): Promise<
  | Readonly<{ state: "captured" }>
  | Readonly<{
      state: "failed";
      reasonCode: "authority_missing" | "replay_failed" | "write_failed";
    }>
> {
  const artifact = await collectProductionLiveArtifact(input, ports);
  if (Object.values(artifact.authorities).some((authority) => authority.status !== "present")) {
    return { state: "failed", reasonCode: "authority_missing" };
  }
  if (replayLiveArtifact(artifact).overall !== "pass") {
    return { state: "failed", reasonCode: "replay_failed" };
  }
  const written = await new LiveArtifactWriter(input.artifactRoot).write(
    input.artifactFileName,
    artifact,
  );
  return written.state === "written"
    ? { state: "captured" }
    : {
        state: "failed",
        reasonCode: written.reasonCode === "replay_failed" ? "replay_failed" : "write_failed",
      };
}
