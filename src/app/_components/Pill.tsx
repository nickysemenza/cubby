import Link from "next/link";
import type React from "react";

interface PillProps {
  text: string;
  label?: "ingredient" | "product" | "recipe" | "location";
}

const Pill: React.FC<PillProps> = ({ text, label }) => {
  return (
    <span className="text-primary-foreground hover:bg-primary/90 inline-flex items-center rounded-full bg-blue-500 px-3 py-1 text-sm font-medium transition-colors">
      <span className="truncate">{text}</span>
      {label && (
        <span className="text-primary ml-2 rounded-full bg-blue-300 px-2 py-0.5 text-xs font-semibold">
          {label}
        </span>
      )}
    </span>
  );
};

export const PillLink: React.FC<PillProps & { href: string }> = ({
  href,
  ...pillProps
}) => (
  <Link href={href}>
    <Pill {...pillProps} />
  </Link>
);
export default Pill;
