/**
 * The two form controls the setup screen and its seat rows both draw.
 *
 * Moved out of `SetupScreen.tsx` in MON-747 and into a file of their own rather than into
 * `SeatCard.tsx`, so that the dependency runs one way: the screen and the seat row both read these,
 * and neither of the two reads the other. A radio group and a labelled select know nothing about
 * seats, boards or rule sets, which is why they are the piece that could move first.
 */

interface Option {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * A radio group drawn as chunky cards.
 *
 * Real `<input type="radio">` elements, visually hidden and labelled — so arrow keys move
 * within the group, the label is tied to the input, and the focus ring lands on the card the
 * user can see. A `<div role="radiogroup">` with click handlers would have had to reimplement
 * all three.
 */
export function Choice({
  name,
  label,
  options,
  value,
  onChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly options: readonly Option[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-edge px-4 py-2 text-sm font-medium has-checked:border-current has-checked:bg-current/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => {
                onChange(option.value);
              }}
              className="sr-only"
            />
            <span>{option.label}</span>
            {option.hint !== undefined && (
              <span dir="ltr" className="text-ink-muted text-xs tabular-nums">
                {option.hint}
              </span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A labelled `<select>`, for the choices that are settings rather than the main decision. */
export function Picker({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly Option[];
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="min-h-11 max-w-56 rounded-xl border border-edge bg-transparent px-3"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
