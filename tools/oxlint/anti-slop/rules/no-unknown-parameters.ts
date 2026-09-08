import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function hasTypePredicateReturn(node: ParameterOwner): boolean {
  return node.returnType?.typeAnnotation.type === "TSTypePredicate";
}

function parameterAnnotation(
  parameter: Parameter,
): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceText: string): string {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

function parameterIdentifier(parameter: Parameter): ESTree.Identifier | null {
  if (parameter.type === "TSParameterProperty") {
    return parameterIdentifier(parameter.parameter);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterIdentifier(parameter.left);
  }
  if (parameter.type === "RestElement") {
    return parameterIdentifier(parameter.argument);
  }
  return parameter.type === "Identifier" ? parameter : null;
}

const decoderMethods = new Set([
  "decode",
  "decodeAsync",
  "parse",
  "parseAsync",
  "safeParse",
  "safeParseAsync",
]);

function isDecoderSymbolName(name: string): boolean {
  return (
    /^(?:decode|parse)[A-Z_]/u.test(name) ||
    /(?:Decoder|Parser)$/u.test(name) ||
    /^(?:DECODE|DECODER|PARSE|PARSER)(?:_|$)/u.test(name)
  );
}

function memberName(member: ESTree.MemberExpression): string | null {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  return member.property.type === "Literal"
    ? String(member.property.value)
    : null;
}

function isDecoderCallee(callee: ESTree.CallExpression["callee"]): boolean {
  if (callee.type === "Identifier") return isDecoderSymbolName(callee.name);
  if (callee.type !== "MemberExpression") return false;
  const property = memberName(callee);
  if (property !== null && decoderMethods.has(property)) return true;
  return callee.object.type === "Identifier"
    ? isDecoderSymbolName(callee.object.name)
    : callee.object.type === "MemberExpression" &&
        isDecoderCallee(callee.object);
}

function isDirectDecoderArgument(identifier: ESTree.Identifier): boolean {
  const parent = identifier.parent;
  return (
    parent.type === "CallExpression" &&
    parent.arguments.some((argument) => argument === identifier) &&
    isDecoderCallee(parent.callee)
  );
}

function parameterVariable(
  owner: ParameterOwner,
  parameter: Parameter,
  sourceCode: SourceCode,
): Variable | null {
  const identifier = parameterIdentifier(parameter);
  if (identifier === null) return null;
  return (
    sourceCode.scopeManager
      .getDeclaredVariables(owner)
      .find(
        (variable) =>
          variable.name === identifier.name &&
          variable.defs.some((definition) => definition.type === "Parameter"),
      ) ?? null
  );
}

function isRuntimeFunction(
  owner: ParameterOwner,
): owner is ESTree.ArrowFunctionExpression | ESTree.Function {
  return (
    owner.type === "ArrowFunctionExpression" ||
    owner.type === "FunctionDeclaration" ||
    owner.type === "FunctionExpression"
  );
}

function declaredParserName(owner: ParameterOwner): string | null {
  if (
    (owner.type === "FunctionDeclaration" ||
      owner.type === "FunctionExpression" ||
      owner.type === "TSDeclareFunction") &&
    owner.id !== null
  ) {
    return owner.id.name;
  }
  if (owner.type === "TSMethodSignature") {
    return owner.key.type === "Identifier" ? owner.key.name : null;
  }

  let current: ESTree.Node | null = owner.parent;
  while (current !== null && current.type !== "Program") {
    if (
      current.type === "TSTypeAliasDeclaration" ||
      current.type === "TSInterfaceDeclaration"
    ) {
      return current.id.name;
    }
    current = current.parent;
  }
  return null;
}

function isDecoderParameter(
  owner: ParameterOwner,
  parameter: Parameter,
  sourceCode: SourceCode,
): boolean {
  if (!isRuntimeFunction(owner) || owner.body === null) {
    const name = declaredParserName(owner);
    return (
      name !== null && (decoderMethods.has(name) || isDecoderSymbolName(name))
    );
  }

  const variable = parameterVariable(owner, parameter, sourceCode);
  if (variable === null) return false;
  const reads = variable.references.filter((reference) => reference.isRead());
  return (
    reads.length > 0 &&
    reads.every((reference) => isDirectDecoderArgument(reference.identifier))
  );
}

/** Disallow unknown inputs except error causes and values consumed only by decoders. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause` and genuine schema/parser boundaries.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type or consume every use directly with the boundary schema/parser.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      if (hasTypePredicateReturn(node)) return;
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        const name = parameterName(
          parameter,
          context.sourceCode.getText(parameter),
        );
        if (
          name === "cause" ||
          isDecoderParameter(node, parameter, context.sourceCode)
        ) {
          continue;
        }
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
