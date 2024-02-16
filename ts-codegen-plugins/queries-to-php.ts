/*
Copyright (C) 2024 Alexey Presnyakov

Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
*/

import {
    concatAST,
    FragmentDefinitionNode,
    FragmentSpreadNode,
    GraphQLSchema,
    OperationDefinitionNode
} from 'graphql';
import * as graphql from 'graphql'
import {oldVisit, PluginFunction, Types} from '@graphql-codegen/plugin-helpers';
import {constantCase} from "change-case";
import {Kind} from "graphql/index";
import path = require("node:path");
const fs = require('node:fs');
import {parseTsFile, TAmConstantDef, TParsedTsFile} from "./parse-ts-gql";
import {addTypenameToDocument} from "@apollo/client/utilities";
import {sha256} from "js-sha256";




const rootProjectPath = path.resolve(__dirname + "/../../");

interface NamedOperationsObjectPluginConfig {
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

function normalizeQueryString(q:string) : string {
    return q.replace(/[ \t\n\r]+/gms, ' ')
}

interface TParsedProgramLink {
    konst ?: TAmConstantDef
}


// find destionation for GQuery.php file
function findProjDestFn(mDest:string) : string {
    return rootProjectPath + "/library/GQuery.php";
    throw new Error("Could not find where to create GQuery.php file for mDest=" + mDest + " . Edit function `findProjDestFn()` if necessary ")
}


export const plugin: PluginFunction<NamedOperationsObjectPluginConfig, string> = (
    schema: GraphQLSchema,
    documents: Types.DocumentFile[],
    config: NamedOperationsObjectPluginConfig,
) => {



//
     const allAst = concatAST(documents.map(v => v.document));

     const tsParsedPrograms : Record<string, TParsedTsFile> = {}

     // go through all operations and find all gql.ts files used
     // parse .ts files using typescript parser and find out
     // constant names that define GraphQL operations and its @mDest dockblock values
     oldVisit(allAst, {
        enter: {
            OperationDefinition: (opDef: OperationDefinitionNode) => {
                const fn = opDef.loc?.source?.name
                if (!tsParsedPrograms[fn]) {
                    tsParsedPrograms[fn] = parseTsFile(fn)
                }
                if (tsParsedPrograms[fn]) {
                    (opDef as TParsedProgramLink).konst = undefined
                    tsParsedPrograms[fn].constants.map(konst => {
                         if (konst.opName === opDef.name.value && konst.opOperation === opDef.operation) {
                             (opDef as TParsedProgramLink).konst = konst
                         }
                    })
                    if (!(opDef as TParsedProgramLink).konst) {
                        throw new Error(`internal error - cannot find matching operation in parsed .ts ${fn} : ${opDef.name.value}`)
                    }

                }
            }
        }
     })

    // lint check that all operation+name in all files are unique
    const opNamesSet : Set<string> = new Set()
    Object.values( tsParsedPrograms).forEach(tsp => {
        tsp.constants.forEach(konst => {
            const cval = konst.opOperation + " " + konst.opName
            if (opNamesSet.has(cval)) {
                throw new Error(`Not unique GraphQL operation found: ${cval}, it is already used somewhere else. Second time found in ${konst.fn}:${konst.line}`)
            }
            opNamesSet.add(cval)
        })
    })


    /// fetch all fragment nodes to {} for reference
    const fragmentNodes : Record<string, FragmentDefinitionNode> = {}
    oldVisit(allAst, {
        enter: {
            FragmentDefinition: (node : FragmentDefinitionNode) => {
                fragmentNodes[ node.name.value ] = node
            },
        },
    });

    let opList: Record<string, {
        constName: string // php query const name
        opName: string  // query name from definition
        opType: string // query or mutation
        hash: string // sha256 for persisted q
        body: string // full source with fragments
        node: OperationDefinitionNode,
        moduleName: string,
        tsDefFile: string,
        tsDefLine: number,
    }[]> = {}

    oldVisit(allAst, {
        enter: {
            OperationDefinition: (node: OperationDefinitionNode) => {
               if (!node.name.value) throw new Error("operations without names not supported")

                if (opList[node.name.value]) throw new Error("duplication operation name " + node.name.value )

                let usedFragments : string[] = []

                oldVisit(node, {
                   leave: {
                       FragmentSpread: (fr: FragmentSpreadNode) => {
                           usedFragments.push(fr.name.value)
                       }
                   }
                })
                usedFragments = arrayUnique(usedFragments)
                let setLen = usedFragments.length
                do {
                    usedFragments.forEach(frName => {
                        if (!fragmentNodes[frName]) {
                            throw new Error("Unknown fragment used [" + frName + "] in operation " + node.name.value )
                        }
                        oldVisit(fragmentNodes[frName], {
                            leave: {
                                FragmentSpread: (fr: FragmentSpreadNode) => {
                                    usedFragments.push(fr.name.value)
                                }
                            }
                        })
                    })
                    usedFragments = arrayUnique(usedFragments)
                    if (usedFragments.length == setLen) break;
                    setLen = usedFragments.length
                } while (true)

                let opString = ""
                opString += graphql.print(addTypenameToDocument(node))
                if (usedFragments.length)
                    opString += "\n" + usedFragments.reverse().map(frName => graphql.print(addTypenameToDocument(fragmentNodes[frName])) ).join("\n")

                let moduleName = node.loc.source.name.toLowerCase()
                moduleName = moduleName.replace(/^.+\/src\//, '')
                moduleName = moduleName.replace(/\/gql.ts$/, '')
                moduleName = moduleName.replace('/', '-')
                moduleName = moduleName.replace(/^components-/, '')

                // info from parsed .ts file
                const konst = (node as TParsedProgramLink).konst

                const fn = findProjDestFn(konst.mDest)

                if ( opList[ fn ] === undefined) opList[ fn ] = []

                opList[ fn ].push( {
                    constName: konst.name, /// nodeConstName(node),
                    opName: node.name.value,
                    opType: node.operation.toLowerCase(),
                    hash: sha256(normalizeQueryString( opString )),
                    body: opString,
                    node,
                    moduleName,
                    tsDefFile: path.relative(rootProjectPath, konst.fn),
                    tsDefLine: konst.line,
                } )

            },
        },
    });

    Object.entries(opList).map( ([fn, queries]) => {

        let output =
            "<?php /* this file is auto-generated by codegen, do not edit */\n\n\n"

        output += queries.map(q => {
            return `if (!defined('GQL_${q.constName}')) /** @see /${q.tsDefFile}#${q.tsDefLine} */\n` +
                `\tdefine('GQL_${q.constName}', '${q.hash}');`
        }).join("\n")

        output += "\n\nreturn [\n" ;

        output += queries.map(q => {
            return `'${q.hash}' => ['${q.opType}', '${q.opName}', '${q.constName}', \n` +
            `\t'${q.body}', ],`
        }).join("\n")

        output += "];\n";
        fs.writeFileSync(fn, output)
    } )

    /// const tsFn = './src/graphql/query-hash.ts' <-- set in config file

    let tsOutput = "\n/** this file is autogenerated, do not edit */\n";
    tsOutput += "\n/** createApolloClient is configured to send these hashes instead of actual queries */\n";
    tsOutput += "export const gqlQueryHash : Record<string,string> = {\n";
    tsOutput += Object.values(opList).map(vv => vv.map(v =>
        `    '${v.opName}': '${v.hash}',`
    ).join("\n")).join("\n\n")
    tsOutput += "\n}\n";

    return tsOutput
};
