export default function AppMark({
  size = 32,
  className = "",
  variant = "mark",
}: {
  size?: number;
  className?: string;
  variant?: "mark" | "avatar";
}) {
  const radius = variant === "avatar" ? "rounded-full object-cover" : "object-contain";
  return (
    <img
      src="/app-icon.png"
      alt="KODEX"
      width={size}
      height={size}
      className={`block ${radius} ${className}`.trim()}
      draggable={false}
    />
  );
}
