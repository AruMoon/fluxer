%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_shutdown_drain).
-typing([eqwalizer]).

-export([run/0]).

-define(FRAME_FLUSH_MS, 500).

-spec run() -> ok.
run() ->
    case gateway_node_router:is_draining() of
        true -> ok;
        false -> drain()
    end.

-spec drain() -> ok.
drain() ->
    persistent_term:put({fluxer_gateway, draining}, true),
    Result = shard_utils:safe_apply(
        fun session_manager:reconnect_drain/0,
        {error, unavailable}
    ),
    logger:info("Gateway shutdown drain: ~p", [Result]),
    timer:sleep(?FRAME_FLUSH_MS),
    ok.
