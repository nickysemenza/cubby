"use client";

import { useEffect, useState } from "react";
import { greet, fibonacci } from "../../../recipebridge/pkg/recipebridge";
import { api } from "~/trpc/react";
import JsonRenderer from "../_components/json";
export default function Page() {
  const [message, setMessage] = useState("");
  const [fib, setFib] = useState(0);

  useEffect(() => {
    setMessage(greet("Next.js and WebAssembly"));
    setFib(fibonacci(10));
  }, []);

  const res = api.demo.hello.useQuery({ text: "Hello, tRPC!" });

  return (
    <div>
      <h1>{message}</h1>
      <p>The 10th Fibonacci number is: {fib}</p>
      <JsonRenderer input={res.data} />
    </div>
  );
}
