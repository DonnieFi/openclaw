import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  GatewayErrorDetailCodes,
} from "../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";

const MODEL_CATALOG_WAIT_MS = 30_000;
const MODEL_CATALOG_LOADING_MESSAGE = "Models are still loading; retry in a moment.";

/** The one wire shape for a request that gave up waiting on the published model catalog. */
export function modelCatalogLoadingError(): ErrorShape {
  return errorShape(ErrorCodes.UNAVAILABLE, MODEL_CATALOG_LOADING_MESSAGE, {
    retryable: true,
    details: { code: GatewayErrorDetailCodes.MODEL_CATALOG_LOADING },
  });
}

export class ModelCatalogLoadingError extends Error {
  constructor() {
    super(MODEL_CATALOG_LOADING_MESSAGE);
    this.name = "ModelCatalogLoadingError";
  }
}

/** Bounds one request's catalog wait; the shared catalog publication keeps running. */
export async function waitForModelCatalog<T>(
  catalog: Promise<T>,
  params: { signal?: AbortSignal; connectionSignal?: AbortSignal; assertCurrent: () => void },
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), MODEL_CATALOG_WAIT_MS);
  const waitSignal = params.signal
    ? AbortSignal.any([deadline.signal, params.signal])
    : deadline.signal;
  let connectionSignal = params.connectionSignal;
  try {
    for (;;) {
      try {
        return await racePromiseWithAbortSignal(
          catalog,
          connectionSignal ? AbortSignal.any([waitSignal, connectionSignal]) : waitSignal,
        );
      } catch (error) {
        if (!waitSignal.aborted && !connectionSignal?.aborted) {
          throw error;
        }
        // Disconnect ends only requests whose authority belonged to that connection.
        params.assertCurrent();
        if (waitSignal.aborted) {
          throw new ModelCatalogLoadingError();
        }
        connectionSignal = undefined;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
