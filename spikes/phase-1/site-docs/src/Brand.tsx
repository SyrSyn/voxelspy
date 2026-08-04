import type { CSSProperties } from "react";

interface MarkProps {
  className?: string;
  label?: string;
  monochrome?: boolean;
  size?: number;
}

export function VoxelMark({
  className = "",
  label,
  monochrome = false,
  size = 36,
}: MarkProps) {
  const style = { "--mark-size": `${size}px` } as CSSProperties;

  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`voxel-mark ${monochrome ? "voxel-mark--mono" : ""} ${className}`}
      role={label ? "img" : undefined}
      style={style}
      viewBox="0 0 64 64"
    >
      <path
        className="voxel-mark__ring"
        d="M20 8h24v8h8v8h8v16h-8v8h-8v8H20v-8h-8v-8H4V24h8v-8h8zm4 12v8h-4v8h4v8h16v-8h4v-8h-4v-8z"
      />
      <path
        className="voxel-mark__iris"
        d="M28 24h8v4h4v8h-4v4h-8v-4h-4v-8h4z"
      />
      <path className="voxel-mark__glint" d="M12 16h8v8h-8zM44 40h8v8h-8z" />
    </svg>
  );
}

interface WordmarkProps extends MarkProps {
  compact?: boolean;
}

export function Wordmark({ compact = false, ...markProps }: WordmarkProps) {
  return (
    <span className="wordmark">
      <VoxelMark {...markProps} />
      {!compact && (
        <span className="wordmark__type" aria-label="VoxelSpy">
          <span>Voxel</span>
          <span className="wordmark__accent">Spy</span>
        </span>
      )}
    </span>
  );
}
