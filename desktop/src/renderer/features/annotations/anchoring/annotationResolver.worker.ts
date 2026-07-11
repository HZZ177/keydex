import {
  resolveAnnotationPayload,
  type AnnotationResolverRequest,
  type AnnotationResolverResponse,
} from "./annotationResolverProtocol";

const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<AnnotationResolverRequest>) => void,
  ): void;
  postMessage(message: AnnotationResolverResponse): void;
};

scope.addEventListener("message", (event: MessageEvent<AnnotationResolverRequest>) => {
  let response: AnnotationResolverResponse;
  try {
    response = {
      id: event.data.id,
      ok: true,
      result: resolveAnnotationPayload(event.data.payload),
    };
  } catch (error) {
    response = {
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  scope.postMessage(response);
});
