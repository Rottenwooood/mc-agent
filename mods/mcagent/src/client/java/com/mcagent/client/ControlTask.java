package com.mcagent.client;

import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;

/**
 * A control primitive that spans multiple client ticks (goto / dig / attack / smelt ...).
 *
 * <p>The client thread owns all world state, so the task is stepped once per tick by
 * {@link ControlDispatcher}. The HTTP thread that requested it simply waits on {@link #future()}.
 * Every task carries a wall-clock budget so a stuck operation can never hold the body forever.
 */
public abstract class ControlTask {

    private final CompletableFuture<JsonObject> future = new CompletableFuture<>();
    private final long deadlineMs;
    private final String label;
    private boolean cancelled;

    protected ControlTask(String label, long budgetMs) {
        this.label = label;
        this.deadlineMs = System.currentTimeMillis() + Math.max(0L, budgetMs);
    }

    public final String label() {
        return label;
    }

    public final CompletableFuture<JsonObject> future() {
        return future;
    }

    public final boolean expired() {
        return System.currentTimeMillis() > deadlineMs;
    }

    /** Milliseconds left before the task self-expires (may be negative). */
    public final long remainingMs() {
        return deadlineMs - System.currentTimeMillis();
    }

    protected final boolean cancelled() {
        return cancelled;
    }

    /** Called once per client tick; return {@code true} when the task is finished. */
    public abstract boolean step();

    /** Cancel the task (e.g. a stop_motion request): release control and finish. */
    public final void cancel() {
        if (future.isDone()) {
            return;
        }
        cancelled = true;
        try {
            onCancel();
        } catch (Throwable ignored) {
            // cancellation must never throw
        }
        complete(Wire.rejected("cancelled"));
    }

    protected void onCancel() {}

    public final void complete(JsonObject receipt) {
        future.complete(receipt);
    }
}
