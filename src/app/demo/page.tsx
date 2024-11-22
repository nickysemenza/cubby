"use client";

import { useEffect, useState } from "react";
import {
  greet,
  fibonacci,
  parse_ingredient,
} from "../../../recipebridge/pkg/recipebridge";
import { api } from "~/trpc/react";
import JsonRenderer from "../_components/json";
import { JsonEditor } from "json-edit-react";

import { useForm, type SubmitHandler } from "react-hook-form";
import { Input } from "@headlessui/react";

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
      <JsonEditor data={{ data: res.data }} />
      <WASMTest />
    </div>
  );
}

type Inputs = {
  example: string;
  exampleRequired: string;
};

export function WASMTest() {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<Inputs>();
  const onSubmit: SubmitHandler<Inputs> = (data) => console.log(data);
  const foo: string | undefined = watch("example");
  const bar = parse_ingredient(foo || "");
  console.log(foo, bar); // watch input value by passing the name of it

  return (
    <div>
      <form onSubmit={handleSubmit(onSubmit)}>
        {/* register your input into the hook by invoking the "register" function */}
        <input defaultValue="1 cup flour" {...register("example")} />

        {/* include validation with required or other standard HTML validation rules */}
        <Input
          type="text"
          {...register("exampleRequired", { required: true })}
        />
        {/* errors will return when field validation fails  */}
        {errors.exampleRequired && <span>This field is required</span>}

        <input type="submit" />
      </form>
      <JsonEditor data={bar} />
    </div>
  );
}
