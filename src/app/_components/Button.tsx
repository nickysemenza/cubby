import React from "react";

type ButtonProps = {
  onClick: () => void;
  children: React.ReactNode;
};
export function Button(props: ButtonProps) {
  return <button onClick={props.onClick}>{props.children}</button>;
}
