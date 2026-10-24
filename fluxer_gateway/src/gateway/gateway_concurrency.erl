%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_concurrency).
-typing([eqwalizer]).
-behaviour(gen_server).

-export([
    start_link/0,
    request_session_start/1,
    release_session_start/0,
    try_acquire_guild_start/0,
    release_guild_start/0,
    session_start_count/0,
    guild_start_count/0
]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(SESSION_START_IDX, 1).
-define(GUILD_START_IDX, 2).

-type state() :: #{
    counters := counters:counters_ref(),
    session_queue := queue:queue({pid(), term()}),
    session_holders := #{pid() => non_neg_integer()},
    monitors := #{pid() => reference()}
}.

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    case gen_server:start_link({local, ?MODULE}, ?MODULE, [], []) of
        {ok, Pid} -> {ok, Pid};
        {error, Reason} -> {error, Reason};
        ignore -> {error, ignore}
    end.

-spec request_session_start(term()) -> ok.
request_session_start(Tag) ->
    gen_server:cast(?MODULE, {request_session_start, self(), Tag}).

-spec release_session_start() -> ok.
release_session_start() ->
    gen_server:cast(?MODULE, {release_session_start, self()}).

-spec try_acquire_guild_start() -> ok | {error, at_capacity}.
try_acquire_guild_start() ->
    try_acquire(?GUILD_START_IDX, fun gateway_rollout_config:max_concurrent_guild_starts/0).

-spec try_acquire(pos_integer(), fun(() -> pos_integer())) -> ok | {error, at_capacity}.
try_acquire(Idx, LimitFun) ->
    try
        gen_server:call(?MODULE, {acquire, Idx, LimitFun()}, infinity)
    catch
        exit:_ -> ok
    end.

-spec do_acquire(pos_integer(), integer(), counters:counters_ref()) ->
    ok | {error, at_capacity}.
do_acquire(Idx, Limit, Ref) ->
    Count = counters:get(Ref, Idx),
    case Count >= Limit of
        true ->
            {error, at_capacity};
        false ->
            counters:add(Ref, Idx, 1),
            ok
    end.

-spec release_guild_start() -> ok.
release_guild_start() ->
    release_counter(?GUILD_START_IDX).

-spec release_counter(pos_integer()) -> ok.
release_counter(Idx) ->
    try
        Ref = persistent_term:get(gateway_concurrency_counters),
        case counters:get(Ref, Idx) of
            Value when Value > 0 ->
                counters:sub(Ref, Idx, 1);
            _ ->
                counters:put(Ref, Idx, 0)
        end,
        ok
    catch
        error:badarg -> ok
    end.

-spec session_start_count() -> non_neg_integer().
session_start_count() ->
    Ref = persistent_term:get(gateway_concurrency_counters),
    max(0, counters:get(Ref, ?SESSION_START_IDX)).

-spec guild_start_count() -> non_neg_integer().
guild_start_count() ->
    Ref = persistent_term:get(gateway_concurrency_counters),
    max(0, counters:get(Ref, ?GUILD_START_IDX)).

-spec init([]) -> {ok, state()}.
init([]) ->
    erlang:process_flag(fullsweep_after, 50),
    Ref = counters:new(2, [write_concurrency]),
    persistent_term:put(gateway_concurrency_counters, Ref),
    {ok, #{
        counters => Ref,
        session_queue => queue:new(),
        session_holders => #{},
        monitors => #{}
    }}.

-spec handle_call(term(), gen_server:from(), state()) -> {reply, term(), state()}.
handle_call({acquire, Idx, Limit}, _From, #{counters := Ref} = State) when
    is_integer(Idx), is_integer(Limit)
->
    {reply, do_acquire(Idx, Limit, Ref), State};
handle_call(_Request, _From, State) ->
    {reply, ok, State}.

-spec handle_cast(term(), state()) -> {noreply, state()}.
handle_cast({request_session_start, Pid, Tag}, #{session_queue := Queue} = State) when
    is_pid(Pid)
->
    Monitored = ensure_monitor(Pid, State),
    {noreply, admit_session_starts(Monitored#{session_queue := queue:in({Pid, Tag}, Queue)})};
handle_cast({release_session_start, Pid}, #{session_holders := Holders} = State) when
    is_pid(Pid)
->
    case maps:get(Pid, Holders, 0) of
        Held when Held > 0 ->
            Released = release_held(Pid, 1, State),
            {noreply, admit_session_starts(Released)};
        _ ->
            {noreply, State}
    end;
handle_cast(_Msg, State) ->
    {noreply, State}.

-spec handle_info(term(), state()) -> {noreply, state()}.
handle_info({'DOWN', MonitorRef, process, Pid, _Reason}, State) when is_pid(Pid) ->
    #{session_holders := Holders, session_queue := Queue, monitors := Monitors} = State,
    case maps:get(Pid, Monitors, undefined) of
        MonitorRef ->
            Released = release_held(Pid, maps:get(Pid, Holders, 0), State),
            Remaining = queue:filter(fun({QueuedPid, _Tag}) -> QueuedPid =/= Pid end, Queue),
            {noreply,
                admit_session_starts(Released#{
                    session_queue := Remaining, monitors := maps:remove(Pid, Monitors)
                })};
        _ ->
            {noreply, State}
    end;
handle_info(_Info, State) ->
    {noreply, State}.

-spec ensure_monitor(pid(), state()) -> state().
ensure_monitor(Pid, #{monitors := Monitors} = State) ->
    case maps:is_key(Pid, Monitors) of
        true -> State;
        false -> State#{monitors := Monitors#{Pid => erlang:monitor(process, Pid)}}
    end.

-spec release_held(pid(), non_neg_integer(), state()) -> state().
release_held(_Pid, 0, State) ->
    State;
release_held(Pid, Count, #{counters := Ref, session_holders := Holders} = State) ->
    counters:sub(Ref, ?SESSION_START_IDX, Count),
    case maps:get(Pid, Holders, 0) - Count of
        Left when Left > 0 -> State#{session_holders := Holders#{Pid => Left}};
        _ -> State#{session_holders := maps:remove(Pid, Holders)}
    end.

-spec admit_session_starts(state()) -> state().
admit_session_starts(State) ->
    admit_session_starts(gateway_rollout_config:max_concurrent_session_starts(), State).

-spec admit_session_starts(integer(), state()) -> state().
admit_session_starts(Limit, #{counters := Ref, session_queue := Queue} = State) ->
    case counters:get(Ref, ?SESSION_START_IDX) < Limit andalso queue:out(Queue) of
        {{value, {Pid, Tag}}, Rest} ->
            Pid ! {session_start_admitted, Tag},
            counters:add(Ref, ?SESSION_START_IDX, 1),
            Holders = maps:get(session_holders, State),
            Admitted = State#{
                session_queue := Rest,
                session_holders := Holders#{Pid => maps:get(Pid, Holders, 0) + 1}
            },
            admit_session_starts(Limit, Admitted);
        _ ->
            State
    end.

-spec terminate(term(), state()) -> ok.
terminate(_Reason, _State) ->
    ok.

-spec code_change(term(), state(), term()) -> {ok, state()}.
code_change(_OldVsn, State, _Extra) ->
    erlang:garbage_collect(),
    {ok, State}.
