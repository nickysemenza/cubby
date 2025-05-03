import Link from "next/link";
import type React from "react";
import { type Entity } from "~/entities/types";

interface PillProps {
  text: string;
  entity?: Entity;
  label?: string;
}

export const EntityPill: React.FC<PillProps> = ({ text, entity, label }) => {
  return (
    <span className="text-primary-foreground hover:bg-primary/90 inline-flex items-center truncate rounded-full bg-blue-500 px-2 py-1 text-sm font-medium transition-colors">
      <span className="truncate">{text}</span>
      {entity && (
        <span className="text-primary ml-2 rounded-full bg-blue-200 px-1 py-0.5 text-xs font-semibold">
          {entity}
        </span>
      )}
      {label && (
        <span className="text-primary ml-2 rounded-full bg-purple-300 px-1 py-0.5 text-xs font-semibold">
          {label}
        </span>
      )}
    </span>
  );
};
export const IngredientPillLink: React.FC<{ name: string; id: string }> = ({
  name,
  id,
}) => <PillLink href={`/ingredients/${id}`} text={name} entity="ingredient" />;
export const LocationPillLink: React.FC<{
  location: { name: string; id: string; type: string };
}> = ({ location: { name, id, type } }) => (
  <PillLink
    href={`/locations/${id}`}
    text={name}
    entity={"location"}
    label={type}
  />
);
export const RecipePillLink: React.FC<{
  recipe: { name: string; id: string };
}> = ({ recipe: { name, id } }) => (
  <PillLink href={`/recipes/${id}`} text={name} entity={"recipe"} />
);
export const ProductPillLink: React.FC<{
  product: { name: string; id: string; manufacturer: string };
}> = ({ product: { name, id, manufacturer } }) => (
  <PillLink
    href={`/products/${id}`}
    text={name}
    label={manufacturer}
    entity={"product"}
  />
);

const PillLink: React.FC<PillProps & { href: string }> = ({
  href,
  ...pillProps
}) => (
  <Link href={href}>
    <EntityPill {...pillProps} />
  </Link>
);
