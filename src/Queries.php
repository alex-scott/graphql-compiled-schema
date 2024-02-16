<?php
/*
Copyright (C) 2023 Alexey Presnyakov

Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
*/

namespace GSchema;

// note: sha256 query calculated after query string normalization
// like this: queryString.replace(/[ \t\n\r]+/gms, ' ')
//
class Queries
{
    // format: [ 'query|mutation', 'opName', 'tsKonstName', 'plain-text-query',
    //    fn() = 'parsed-query(will be implemented later)' ],
    protected array $queries;

    function __construct()
    {
        $this->queries = require __DIR__ . '/GQuery.php';
        if (!count($this->queries)) throw new \Exception("GQuery.php not returned an array, internal error");

    }

    /** merge data from GQuery.php arrays */
    static public function merge(array $before, array $after)
    {
        return array_merge($before, $after);
    }

    public function opname(string $hash): ?string
    {
        $_ = $this->queries[$hash] ?? false;
        return $_ ? $_[1] : null;
    }

    public function source(string $hash): ?string
    {
        $_ = $this->queries[$hash] ?? false;
        return $_ ? $_[3] : null;
    }

}

