<?php
namespace GSchema;
/*
Copyright (C) 2023 Alexey Presnyakov

Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
*/

use GraphQL\Type\Definition\ResolveInfo;

class Directive
{
    private static $directives;


    /**
     * @param $type
     * @param $classOrCallback Class with __invoke method, or callback : function(array $args, Context $context, callable $next)
     *                         should return actual value, or null
     * @return void
     */

    static function register($name, $classOrCallback)
    {

        if (is_callable($classOrCallback)) {
            self::$directives[$name] = $classOrCallback;
        } else if (is_string($classOrCallback) && class_exists($classOrCallback)) {
            self::$directives[$name] = new $classOrCallback;
        } else {
            throw new Am_Exception_InternalError(sprintf("Wrong directive setup: %s", $name));

        }

    }

    static function WrapDirectives($directives, $callback)
    {
        return function ($value, $args, $context, ResolveInfo $resolveInfo) use ($directives, $callback) {
            $callback = fn() => $callback($value, $args, $context, $resolveInfo);
            foreach ($directives as $directive) {
                if (!isset(self::$directives[$directive['name']])) {
                    throw new \Exception(sprintf("Directive %s is not set", $directive['name']));
                }
                $directiveCallback = self::$directives[$directive['name']];
                $callback = fn() => $directiveCallback($directive['args'] ?? [], $context, $callback);
            }
            return $callback();
        };
    }

    static function __callStatic($name, $arguments)
    {
        if (!isset(self::$directives[$name])) {
            return function () use ($name) {
                throw new \Exception(sprintf("Unknown directive %s", $name));
            };
        }

        $directiveCallback = self::$directives[$name];

        $directiveArgs = $arguments[1] ?? [];
        $callback = $arguments[0] ?? fn() => null;

        return function ($value, $args, $context, ResolveInfo $resolveInfo) use ($callback, $directiveArgs, $directiveCallback) {
            return $directiveCallback($directiveArgs, $context, fn() => $callback($value, $args, $context, $resolveInfo));
        };
    }
}