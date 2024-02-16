<?php declare(strict_types=1);
/*
Copyright (C) 2023 Alexey Presnyakov

Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
*/

namespace GSchema;

use GraphQL\Error\Error;
use GraphQL\Type\Definition\NamedType;
use GraphQL\Type\Definition\ResolveInfo;
use GraphQL\Type\Definition\Type;
use GraphQL\Type\SchemaConfig;

class Schema
{
    protected \GraphQL\Type\Schema $schema;

    /** @var array<string, callable|callable[]> */
    protected array $defs;

    /** @var array<string, \GraphQL\Type\Definition\Type> */
    protected array $types = [];
    /** @var array<string, \Closure> */
    protected array $closures = [];
    /**  */
    protected \SplObjectStorage $resolvers;

    public function __construct()
    {
        $this->resolvers = new \SplObjectStorage();
    }

    /**
     * Merge type-definition arrays
     * @param array
     * @param $arr
     * @return array
     */
    public static function merge(array $before, array $add): array
    {
        return array_merge_recursive($before, $add);
    }

    public function _schemaFromArray(array $defs)
    {

        if (isset($this->schema) || isset($this->defs)) throw new \Exception("logic error, called twice");

        $this->defs = $defs;

        $schemaConfig = new SchemaConfig();
        $schemaConfig->setTypeLoader([$this, 'getType']);
        $schemaConfig->setQuery($this->getType("Query"));
        $schemaConfig->setMutation($this->getType("Mutation"));
        $schemaConfig->setAssumeValid(false); // true for production build

        $this->schema = new \GraphQL\Type\Schema($schemaConfig);
    }


    function schema(): \GraphQL\Type\Schema
    {
        if (!isset($this->schema)) {

            $defs = require __DIR__ . '/GSchema.php';
            if (!count($defs)) throw new \Exception("Invalid GSchema.php - empty array returned");

            $this->_schemaFromArray($defs);
        }
        return $this->schema;
    }

    /** @return callable */
    function _fieldsResolver($originalCallback)
    {
        return function ($value, $args, $context, ResolveInfo $resolveInfo) use ($originalCallback) {

            if (!$this->resolvers->offsetExists($resolveInfo->parentType)) {
                $this->resolvers[$resolveInfo->parentType] = $originalCallback();
            }

            $resolversArray = $this->resolvers[$resolveInfo->parentType] ?? [];

            if (isset($resolveInfo->fieldDefinition->config['directives']) && !empty($resolveInfo->fieldDefinition->config['directives'])) {
                $resolversArray[$resolveInfo->fieldName] = Directive::WrapDirectives(
                    $resolveInfo->fieldDefinition->config['directives'],
                    $resolversArray[$resolveInfo->fieldName]
                );
            }
            if ($resolversArray[$resolveInfo->fieldName]) {
                return $resolversArray[$resolveInfo->fieldName] ($value, $args, $context, $resolveInfo);
            }

            throw new \Exception("Fields resolver for type [{$resolveInfo->parentType->name}] " .
                " does not define resolver for requested field [{$resolveInfo->fieldName}] ");
        };
    }

    protected function createType(string $typeName): ?Type
    {
        // first level is called immediately as $type('...') in GSchema.php
        // then second level is lazy executed when type accessed
        $lazyLoad = fn(string $t) => $this->getType($t);

        $defCallback = $this->defs[$typeName] ?? null;
        if (!$defCallback) return null;
        if (!is_array($defCallback)) throw new \Exception("GQL type callback must always be in array");

        $defs = array_map(fn($c) => $c($lazyLoad), $defCallback);
        if (count($defs) > 1) {
            $def = ['', []];
            $fieldsCb = []; // we collect all fields callbacks to call it at once
            foreach ($defs as $d) { // merge definitions from serveral graphql files into one definition
                $def[0] = $d[0];
                if ($d[1]['fields'] ?? null) $fieldsCb[] = $d[1]['fields'];
                unset($d[1]['fields']);
                $def[1] = array_merge($def[1], $d[1]);
            }
            if ($fieldsCb) $def[1]['fields'] = fn() => array_merge_recursive(...array_map('call_user_func', $fieldsCb));
        } else {
            [$def] = $defs;
        }

        if ($def[1] && isset($def[1]['resolveField'])) {
            $def[1]['resolveField'] = self::_fieldsResolver($def[1]['resolveField']);
        }

        if (!class_exists('\\' . $def[0], true))
            throw new \Exception("Invalid PHP class requested from GSchema:" . $def[0]);

        return new $def[0]($def[1]);
    }

    /** @return (Type&NamedType)|null */
    function getType(string $typeName): ?Type
    {
        $ltypeName = strtolower($typeName);
        switch ($ltypeName) {
            case "boolean":
                return Type::boolean();
            case "float":
                return Type::float();
            case "id":
                return Type::id();
            case "int":
                return Type::int();
            case "string":
                return Type::string();
            default:
                return $this->types[$ltypeName] ??= $this->createType($typeName);
        }
    }

    public function defaultFieldResolver($rv, array $args, $context, ResolveInfo $info)
    {
        throw new Error("Default resolver called for "
            . $info->parentType->name . "->" . implode('.', $info->path)
            . ". You have to configure resolver for each field in schema");
    }

}



