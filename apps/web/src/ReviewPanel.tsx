import "./review.css";
import { useState } from "react";
import {
  markupSchema,
  type Markup,
  type SavedView,
  type Vec3,
} from "@voxelspy/contracts";
import {
  MAX_REVIEW_MARKUPS,
  MAX_REVIEW_VIEWS,
  REVIEW_TIMESTAMP,
  nextReviewId,
  parseReviewPoint,
  removeReviewMarkup,
  type ReviewContent,
} from "./review";
export interface ReviewPanelProps {
  review: ReviewContent;
  onChange: (review: ReviewContent) => void;
  onCapture: (name: string) => void;
  onRestore: (view: SavedView) => void;
  onSelect: (id: Markup["id"]) => void;
  selectedMarkupId?: Markup["id"] | undefined;
  selectedAnchor?: Vec3 | undefined;
  cameraDescription: string;
}
export function ReviewPanel({
  review,
  onChange,
  onCapture,
  onRestore,
  onSelect,
  selectedMarkupId,
  selectedAnchor,
  cameraDescription,
}: ReviewPanelProps) {
  const [kind, setKind] = useState<"callout" | "distance">("callout");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [start, setStart] = useState("0,0,0");
  const [end, setEnd] = useState("1,0,0");
  const [viewName, setViewName] = useState("");
  const [error, setError] = useState<string>();
  const safely = (action: () => void) => {
    try {
      action();
      setError(undefined);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Review action failed safely.",
      );
    }
  };
  return (
    <details
      aria-labelledby="review-title"
      className="session-panel review-panel"
    >
      <summary id="review-title">
        Review annotations and views ({review.markups.length} annotations,{" "}
        {review.savedViews.length} named views)
      </summary>
      <p>
        Author points in the comparison frame, in millimetres. Coordinates are
        deliberate annotations, not verified surface picks.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          safely(() => {
            if (review.markups.length >= MAX_REVIEW_MARKUPS)
              throw new Error(
                `At most ${MAX_REVIEW_MARKUPS} annotations can be authored.`,
              );
            const first = parseReviewPoint(start);
            const last =
              kind === "distance" ? parseReviewPoint(end) : undefined;
            const common = {
              contractVersion: 1,
              id: nextReviewId("markup.user", [
                ...review.markups.map((item) => item.id),
                ...review.savedViews.map((item) => item.id),
              ]),
              label: label.trim(),
              visible: true,
              createdAt: REVIEW_TIMESTAMP,
              attribution: { kind: "anonymous" },
            };
            const frame = { kind: "comparison" };
            const markup = markupSchema.parse(
              kind === "callout"
                ? {
                    ...common,
                    kind,
                    anchor: { frame, pointMillimetres: first },
                    text: text.trim(),
                  }
                : {
                    ...common,
                    kind,
                    start: { frame, pointMillimetres: first },
                    end: { frame, pointMillimetres: last },
                    valueMillimetres: Math.hypot(
                      ...first.map((value, index) => last![index]! - value),
                    ),
                  },
            );
            onChange({ ...review, markups: [...review.markups, markup] });
            onSelect(markup.id);
            setLabel("");
            setText("");
          });
        }}
      >
        <label>
          Annotation type{" "}
          <select
            aria-label="Annotation type"
            value={kind}
            onChange={(event) =>
              setKind(event.currentTarget.value as typeof kind)
            }
          >
            <option value="callout">Callout note</option>
            <option value="distance">Distance</option>
          </select>
        </label>
        <label>
          Annotation label{" "}
          <input
            value={label}
            maxLength={120}
            required
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        <label>
          Start / anchor (mm){" "}
          <input
            value={start}
            required
            onChange={(event) => setStart(event.currentTarget.value)}
          />
        </label>
        {selectedAnchor && (
          <button
            type="button"
            onClick={() => setStart(selectedAnchor.join(","))}
          >
            Use selected region anchor
          </button>
        )}
        {kind === "callout" ? (
          <label>
            Callout text{" "}
            <textarea
              value={text}
              maxLength={2000}
              required
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </label>
        ) : (
          <label>
            End point (mm){" "}
            <input
              value={end}
              required
              onChange={(event) => setEnd(event.currentTarget.value)}
            />
          </label>
        )}
        <button type="submit">Add annotation</button>
      </form>
      <ul aria-label="Review annotations">
        {review.markups.map((markup) => (
          <li key={markup.id}>
            <button
              type="button"
              aria-pressed={selectedMarkupId === markup.id}
              onClick={() => onSelect(markup.id)}
            >
              Select annotation {markup.label}
            </button>
            <label>
              <input
                type="checkbox"
                autoComplete="off"
                checked={markup.visible}
                onChange={() =>
                  onChange({
                    ...review,
                    markups: review.markups.map((item) =>
                      item.id === markup.id
                        ? { ...item, visible: !item.visible }
                        : item,
                    ),
                  })
                }
              />
              Show annotation {markup.label}
            </label>
            <p>
              {markup.kind === "callout"
                ? markup.text
                : `${markup.valueMillimetres} mm; ${markup.start.pointMillimetres.join(", ")} to ${markup.end.pointMillimetres.join(", ")}`}
            </p>
            <button
              type="button"
              onClick={() => onChange(removeReviewMarkup(review, markup.id))}
            >
              Delete annotation {markup.label}
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          safely(() => {
            if (review.savedViews.length >= MAX_REVIEW_VIEWS)
              throw new Error(
                `At most ${MAX_REVIEW_VIEWS} named views can be saved.`,
              );
            onCapture(viewName.trim());
            setViewName("");
          });
        }}
      >
        <label>
          Saved view name{" "}
          <input
            value={viewName}
            maxLength={120}
            required
            onChange={(event) => setViewName(event.currentTarget.value)}
          />
        </label>
        <button type="submit">Save named view</button>
      </form>
      <ul aria-label="Named review views">
        {review.savedViews.map((view) => (
          <li key={view.id}>
            <button
              type="button"
              aria-pressed={review.activeSavedViewId === view.id}
              onClick={() => safely(() => onRestore(view))}
            >
              Restore view {view.name}
            </button>
            <button
              type="button"
              onClick={() => {
                const { activeSavedViewId, ...rest } = review;
                onChange({
                  ...rest,
                  savedViews: review.savedViews.filter(
                    (item) => item.id !== view.id,
                  ),
                  ...(activeSavedViewId && activeSavedViewId !== view.id
                    ? { activeSavedViewId }
                    : {}),
                });
              }}
            >
              Delete view {view.name}
            </button>
          </li>
        ))}
      </ul>
      <details>
        <summary>Current camera in comparison millimetres</summary>
        <output data-testid="review-camera">{cameraDescription}</output>
      </details>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
