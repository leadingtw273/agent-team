export interface SignatureProbeResult {
  [key: string]: boolean | string;
}

export interface DeliveryDecision {
  classification: "accepted" | "accepted_out_of_order" | "duplicate";
  persisted: boolean;
  projectionEligible: boolean;
}

export function githubProbe(): SignatureProbeResult;
export function linearProbe(): SignatureProbeResult;
export function orderingProbe(): {
  newest: DeliveryDecision;
  older: DeliveryDecision;
  replay: DeliveryDecision;
};
export function latencyProbe(): {
  iterations: number;
  p95Under100Ms: boolean;
  p95Bucket: "under_1ms" | "under_10ms" | "under_100ms";
};
export function timeoutProbe(): {
  inboxPersistedBeforeAck: boolean;
  ackStatus: number;
  ackTargetMs: number;
  providerTimeoutMs: number;
  simulatedPostAckProcessingMs: number;
  processingRunsAfterAck: boolean;
  providerRetryRequiredForProcessingTimeout: boolean;
};
