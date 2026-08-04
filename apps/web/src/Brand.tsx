export function VoxelMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      className="voxel-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="VoxelSpy"
    >
      <path d="M10 18h12V8h20v10h12v28H42v10H22V46H10zm12 0v8h20v-8zm0 20v8h20v-8z" />
      <rect x="26" y="27" width="12" height="10" rx="2" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <VoxelMark />
      <span>Voxel<span>Spy</span></span>
    </span>
  );
}
