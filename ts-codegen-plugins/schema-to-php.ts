/*
Copyright (C) 2024 Alexey Presnyakov

Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
*/

import {
    ConstDirectiveNode,
    FieldDefinitionNode,
    FragmentDefinitionNode,
    GraphQLNamedType,
    GraphQLSchema,
    ListTypeNode,
    NamedTypeNode,
    NonNullTypeNode,
    OperationDefinitionNode
} from 'graphql';
import {PluginFunction, Types} from '@graphql-codegen/plugin-helpers';
import {constantCase} from "change-case";
import {Kind} from "graphql/index";
import {ConstValueNode, InputValueDefinitionNode} from "graphql/language/ast";
import path = require("node:path");

const fs = require('node:fs');

const rootProjPath = path.resolve(__dirname + "/../../");

export interface NamedOperationsObjectPluginConfig {
}

const nodeConstName = (node: OperationDefinitionNode | FragmentDefinitionNode ): string => {
    const origName = node.name.value
    let name = constantCase(node.name.value)
    let stName = ""
    if (node.kind === Kind.OPERATION_DEFINITION) {
        stName = node.operation.toUpperCase() + "_"
    } else if (node.kind === Kind.FRAGMENT_DEFINITION) {
        stName = "FRAGMENT_"
    }

    if (!name.startsWith(stName)) name = stName + name
    return name
}


function arrayUnique(a: string[]) : string[] {
    function onlyUnique(value, index, self) {
        return self.indexOf(value) === index;
    }
    return a.filter( onlyUnique ); // returns ['a', 1, 2, '1']
}


function determineModuleByGraphqlLocation(gqlFn: string) :string {
    let gg = gqlFn.replace(/.+?\/application\//, '')
        .replace(/\.graphql$/, '')
    const a = gg.split(/\/|\\\\/)
    if (a.length != 2 || a[0] !== a[1] || !a[0]) throw new Error("Invalid graphql file name, does not match pattern: " + gg)
    return a[0]
}


function resultPhpSchemaLocation(module:string) {
    return rootProjPath + `/library/GSchema.php`;
}

// field type definition
function generateCodeForTypename(typeNode: NamedTypeNode | ListTypeNode | NonNullTypeNode) : string {
    if (typeNode.kind === Kind.NAMED_TYPE) {
        // console.log(typeNode.name.value, typeNode?.loc?.source?.name)
        switch (typeNode.name.value) {
            case 'ID': return 'Type::id()';
            case 'String': return 'Type::string()';
            case 'Boolean': return 'Type::boolean()';
            case 'Int': return 'Type::int()';
            case 'Float': return 'Type::float()';
            default:
                return `$type('${typeNode.name.value}')`;
        }
    } else if (typeNode.kind === Kind.LIST_TYPE) {
        return 'Type::listOf(' + generateCodeForTypename(typeNode.type) + ")";
    } else if (typeNode.kind === Kind.NON_NULL_TYPE) {
        return 'Type::nonNull(' + generateCodeForTypename(typeNode.type) + ")";
    }
}

function generateDefaultValue(defVal: ConstValueNode) : string {

    switch (defVal.kind) {
        case Kind.STRING:
            return JSON.stringify(defVal.value)
        case Kind.INT:
            return defVal.value;
        case Kind.FLOAT:
            return defVal.value;
        case Kind.LIST:
            return "[" + defVal.values.map(generateDefaultValue).join(", ") + "]";
        case Kind.NULL:
            return "null";
        case Kind.ENUM:
            return "$enumDefault(" + JSON.stringify(defVal.value) + ")";
        case Kind.BOOLEAN:
            return defVal.value ? "true" : "false";
        default:
            throw new Error("this kind of default type is not supported:" + defVal.kind)
    }
}

function generateArgsListForField(args: ReadonlyArray<InputValueDefinitionNode>, indent) : string {

    const str = args.map(arg => {
        return `\t${indent}'${arg.name.value}' => [\n`+
            `\t\t${indent}'type' => ` + generateCodeForTypename(arg.type) + ",\n" +
            ( arg.description ? `\t\t${indent}'description' => ` + JSON.stringify(arg.description.value) + ",\n" : "" ) +
            ( arg.defaultValue ? `\t\t${indent}'defaultValue' => ` + generateDefaultValue(arg.defaultValue) + ",\n" : "" ) +
            `\t${indent}],`
    }).join("\n")

    return `${indent}'args' => [\n` +
        `${str}\n` +
        `${indent}],\n`
}

function generateDirectivesList(directives: TDirConfig, indent) : string {

    let  str = `${indent}'directives' => [\n`;
    for(let i of directives){
        str = str + `\t${indent}[\n` +
            `\t\t${indent}'name' => '${i.name}',\n`+
            `\t\t${indent}'args' => [\n`
        for(let a of i.args){
            str = str + `\t\t\t${indent}\t'${a.name}' => '${a.value}',\n`
        }
        str = str + `\t\t${indent}],\n`
        str = str + `\t${indent}],\n`
    }
    str = str + `${indent}],\n`
    return str;
}
function wrapDirectiveForResolve(directive: TDirective, rVal) : string {

    let str =  "Directive::"+directive.name+`( ${rVal} `;
    if(directive.args.length>0){
        str = str + ', ['
        for(let arg of directive.args){
            str = str + `'${arg.name}' => '${arg.value}', `
        }
        str = str + ']'
    }
    str = str + ')'
    return str;
}

type TDirective = {name: string, args: Array<{name: string, value: string}>}
type TDirConfig = Array<TDirective>
function parseDirectives(directives: readonly ConstDirectiveNode[]){

    let dirs:TDirConfig = []
    for(let i of directives){
        // Skip resolver directives
        if(["f", "r"].includes(i.name.value))
            continue;

        let args: Array<{name: string, value: string}> = [];

        for(let arg of i.arguments){
            args.push({
                name: arg.name.value,
                value: (arg.value as any).value
            })

        }
        dirs.push({
            name: i.name.value,
            args: args
        })
    }
    return dirs;
}

function generateCodeForFields(fields: ReadonlyArray<FieldDefinitionNode|InputValueDefinitionNode>, ident:string="\t\t\t") : string {
    const list = fields.map((fieldDef) => {
        let resolve: string = "";
        let directives: string = "";
        if (fieldDef.kind === Kind.FIELD_DEFINITION) {
            let rVal = getStringFromDirective(fieldDef.directives, "r")

            let dirs = parseDirectives(fieldDef.directives);
            if (rVal) {
                rVal = generatePhpCallbackFromDirectiveString(rVal)
                if(dirs.length>0){
                    for(let directive of dirs){
                        rVal = wrapDirectiveForResolve(directive, rVal);
                    }
                }
                resolve = `${ident}\t'resolve' => ${rVal},\n`;

            }
            if(dirs.length!=0){
                directives = generateDirectivesList(dirs, ident + "\t") ;
            }

        }
        let args = "";
        if (fieldDef.kind === Kind.FIELD_DEFINITION && fieldDef.arguments.length)
            args = generateArgsListForField(fieldDef.arguments, ident + "\t") ;
        return `${ident}'${fieldDef.name.value}' => [\n` +
            `${ident}\t'type' => ${generateCodeForTypename(fieldDef.type)},\n` +
            resolve +
            args +
            directives +
            `${ident}]`;
    })
    return `\n${ident}[\n` +
        list.join(",\n") +
        `\n${ident}],`
}

function generateDiCallback(c:string, m:string):string {
    const a = c.split(/->/)
    if (a[0] === "Di") {
        a[0] = "\\Di::getInstance()"
    } else {
        console.error(a[0])
        throw new Error("di callback must start with Di-> [started with'"+a[0]+"'] : " + c +"," + m )
    }
    // console.log({a})
    if (1==a.length) {
        // like  @r(_: "Di->auth")
        return "fn() => " + a.join("->") + "->" + m
    }
}

function generatePhpCallbackFromDirectiveString(cbStr:string) : string {

    const parse2Method = (s:string) => {
        s = s.trim().replace(/\(\s*\)$/, '')
        const a = s.split(/::|->/)
        if (a.length<2) throw new Error("Invalid cbStr: " + cbStr)
        const last = a.pop()
        return [s.substring(0, s.length-last.length).replace(/(::|->)$/, ''), last]
    }
    let [c, m] = parse2Method(cbStr)
    if (c.startsWith("Di")) {
        const s = generateDiCallback(c, m)
        return s
    } else {
        if (m === "class") {
            return `new \\${c}`;
        } else {
            return `[ \\${c}::class, '${m}']`;
        }
    }
}

function getStringFromDirective(directives:ReadonlyArray<ConstDirectiveNode>, expectedName: string) : string {
    const scalarDirValue = directives.map(dirNode => {
        if (dirNode.name.value === expectedName) {
            return (dirNode.arguments[0].value as any).value as string
        }
        return null
    }).filter(Boolean)
    return scalarDirValue.length ? scalarDirValue[0] : ""
}

function generateCodeForType(typeDef: GraphQLNamedType,
                             objectFieldDefs: ReadonlyArray<FieldDefinitionNode> | undefined,
                             ident:string="\t\t\t") : [ string, Record<string, string> ] {
    const commonFields : Record<string, string> = {
        name: "'" + typeDef.name + "'",
        description: typeDef.description ?? undefined,
    }

    if (typeDef.astNode.kind === Kind.SCALAR_TYPE_DEFINITION) {

        const callback = getStringFromDirective(typeDef.astNode.directives, "scalar")
        if (!callback) throw new Error("@scalar directive must be set for this kind of definition " + typeDef.name )
        if (!callback.startsWith("Scalar\\")) throw new Error("@scalar directive must start with Scalar\ " + typeDef.name )
        return ['CustomScalarType::class', {
            ...commonFields,
            serialize: `[\\${callback}::class, 'serialize' ]`,
            parseValue: `[\\${callback}::class, 'parseValue' ]`,
            parseLiteral: `[\\${callback}::class, 'parseLiteral' ]`,
        } ];
    } else if (typeDef.astNode.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ) {
        const vVal = getStringFromDirective(typeDef.astNode.directives, "v")
        if (vVal) {
            commonFields.parseValue = generatePhpCallbackFromDirectiveString(vVal)
        }
        return ['InputObjectType::class', {
            ...commonFields,
            fields:  generateCodeForFields(typeDef.astNode.fields, ident + "\t"),
        } ];
    } else if (typeDef.astNode.kind === Kind.OBJECT_TYPE_DEFINITION) {
        const fVal = getStringFromDirective(typeDef.astNode.directives, "f")
        if (fVal) {
            commonFields.resolveField = generatePhpCallbackFromDirectiveString(fVal)
        }
        if (typeDef.astNode.interfaces.length) {
            commonFields.interfaces = "fn() => [ " +
                typeDef.astNode.interfaces.map(ifdef => `$type('${ifdef.name.value}')`).join(', ') +
                " ]";
        }
        return ['ObjectType::class', {
            ...commonFields,
            fields:  "fn() => " + generateCodeForFields( ///typeDef.astNode.fields,
                // fields may be defined in several files so we handle it this special way
                objectFieldDefs , ident + "\t"),
        } ];
    } else if (typeDef.astNode.kind === Kind.ENUM_TYPE_DEFINITION) {
        return ['EnumType::class', {
            ...commonFields,
            values: `[\n` +
                typeDef.astNode.values.map(
                    (et) => `${ident}\t'${et.name.value}' => [ 'value' => '${et.name.value}' ],\n`
                ).join("") +
                `${ident}],`,
        } ];
    } else if (typeDef.astNode.kind === Kind.INTERFACE_TYPE_DEFINITION) {
        const tVal = getStringFromDirective(typeDef.astNode.directives, "t")
        if (tVal) {
            commonFields.resolveType = generatePhpCallbackFromDirectiveString(tVal)
        } else {
            if (typeDef.name !== "RecordSet") // it is a special type
                throw new Error("Interface type must have @t resolveType defined " + typeDef.name)
        }
        return ['InterfaceType::class', {
            ...commonFields,
            fields:  generateCodeForFields(typeDef.astNode.fields, ident + "\t"),
        } ];
    } else if (typeDef.astNode.kind === Kind.UNION_TYPE_DEFINITION) {
        const tVal = getStringFromDirective(typeDef.astNode.directives, "t")
        if (tVal) {
            commonFields.resolveType = generatePhpCallbackFromDirectiveString(tVal)
        } else {
            throw new Error("Union type must have @t resolveType defined " + typeDef.name)
        }
        return ["UnionType::class", {
            ...commonFields,
            types: `[\n` +
                typeDef.astNode.types.map(t => `${ident}\t${generateCodeForTypename(t)},\n`).join("") +
                `${ident}],`
            ,
        }];
    } else {
        throw new Error("not supported")
    }


//     return `
//     '[ ${gqlTypeToPhpTypeDefType(typeDef)}, [
//             'name'   => '${typeDef.name}',
//             'fields' => [
// ${generateCodeForFields(typeDef)}
//             ],
//         ],
// `
}

// returns main, default scheme write all other
const dumpSchema = (schema: GraphQLSchema): string => {

    const generatedCode : Record<string, string[]> = {}

    let defaultSchemaOutput = ""

    Object.values(schema.getTypeMap()).forEach( (typeDef) => {
        const fn = typeDef?.astNode?.loc?.source?.name
        if (!fn) return; // skip it , probably a core type
        const module = determineModuleByGraphqlLocation(fn)


        const fieldDefs : Record<string, FieldDefinitionNode[]> = {
            [module]: [],
        }
        if (typeDef.astNode.kind === Kind.OBJECT_TYPE_DEFINITION) {
            typeDef.astNode.fields.map(fdef => {
                const fieldDefinedInModule = determineModuleByGraphqlLocation(fdef.loc?.source?.name) ?? "default"
                if (!fieldDefs[fieldDefinedInModule]) fieldDefs[fieldDefinedInModule] = []
                fieldDefs[ fieldDefinedInModule ].push(fdef)
            })
        }

        Object.entries(fieldDefs).forEach(([module, fieldDefs]) => {

            if (!generatedCode[ module ]) generatedCode[module] = []
            const [phpType, phpTypeConstuctorArray] = generateCodeForType(typeDef, fieldDefs)

            const phpTypeConstuctorArrayStr = '[ ' +
                Object.entries(phpTypeConstuctorArray).map( ([k,v]) => {
                    return v ? `\n\t\t\t'${k}' => ${v}` : false;
                }).filter(Boolean).join(",")
                + " ]";

            generatedCode[module].push(
                `\t\t // -------          ${typeDef.name}     -------- \n`
                +`\t\t'${typeDef.name}' => [ fn($type) => [ ${phpType}, ${phpTypeConstuctorArrayStr}\n`
                +`\t\t]],\n`
                +`\t\t\n`
            )

        })

    })


    Object.entries(generatedCode).forEach(([module, strings]) => {
        strings.unshift(
            `<?php /* this is generated file, do not edit */
namespace GSchema;

use GraphQL\\Definition\\Type;
use GraphQL\\Definition\\ObjectType;
use GraphQL\\Definition\\UnionType;
use GraphQL\\Definition\\EnumType;
use GraphQL\\Definition\\InputObjectType;
use GraphQL\\Definition\\CustomScalarType;
use GraphQL\\Definition\\InterfaceType;

///            
///   auto-generated typedefs from "${module}.graphql"
///   generated by 'npm run codegen'
///   first res: className, second: constructor args
///
return [ 
`
        )

        strings.push(`
];
`)

        if (module !== "default") {
            fs.writeFileSync(resultPhpSchemaLocation(module),
                strings.join("")
            )
        } else {
            defaultSchemaOutput = strings.join("")
        }
    })


    return defaultSchemaOutput
}



export const plugin: PluginFunction<NamedOperationsObjectPluginConfig, string> = (
    schema: GraphQLSchema,
    documents: Types.DocumentFile[],
    config: NamedOperationsObjectPluginConfig,
) => {

    return dumpSchema(schema)

    // uncomment to see output
    process.exit(12)

};
