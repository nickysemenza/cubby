"use client";

import { parse_ingredient } from "../../../recipebridge/pkg/recipebridge";
import { api } from "~/trpc/react";
import { JsonEditor } from "json-edit-react";

import { useForm, type SubmitHandler } from "react-hook-form";
import { Input } from "~/components/ui/input";

export default function Page() {
  const res = api.demo.hello.useQuery({ text: "Hello, tRPC!" });

  return (
    <div>
      <JsonEditor data={{ data: res }} />
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
