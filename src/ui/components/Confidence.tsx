import type { VerifiedField } from "../../core/types";
import { hostnameOf } from "../utils";

export function Confidence({
  field,
}: {
  field: { confidence: VerifiedField["confidence"]; source_url?: string };
}) {
  const cls = `conf conf--${field.confidence}`;
  return (
    <span className={cls}>
      <span className="conf__dot" aria-hidden="true" />
      <span className="conf__label">{field.confidence}</span>
      {field.source_url ? (
        <>
          <span className="conf__sep">·</span>
          <a
            className="conf__source"
            href={field.source_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {hostnameOf(field.source_url)}
          </a>
        </>
      ) : null}
    </span>
  );
}
