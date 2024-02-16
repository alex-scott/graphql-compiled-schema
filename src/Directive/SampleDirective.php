<?php
namespace GSchema\Directive;
/*
Copyright (C) 2023 Alexey Presnyakov

Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
*/

class SampleDirective
{
    function __invoke(array $args, $context, callable $next)
    {
        return $next();
    }

}