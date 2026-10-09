package com.mcagent.observer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Bounded ring buffer of observed world events, read-only.
 *
 * <p>Carries an {@code epoch} that changes on every server start. A consumer holding a
 * cursor {@code (epoch, seq)} must treat an epoch change as a reset, and a request older
 * than the retained window as a reset too. This mirrors the data contract in
 * docs/mcp-implementation-framework.md §10 / docs/research/14 §4.
 */
public final class EventLog {

    public record BlockChange(long seq, long tick, int x, int y, int z,
                              String before, String after, String actor) {}

    private final int capacity;
    private final ArrayDeque<BlockChange> buf = new ArrayDeque<>();
    private long seq = 0L;
    private long epoch = 0L;

    public EventLog(int capacity) {
        this.capacity = Math.max(1, capacity);
    }

    /** Start a new epoch (server start): clears retained events and resets seq. */
    public synchronized long bumpEpoch() {
        epoch += 1L;
        seq = 0L;
        buf.clear();
        return epoch;
    }

    public synchronized long epoch() {
        return epoch;
    }

    public synchronized long latestSeq() {
        return seq;
    }

    /** Oldest seq still retained; if empty, one past the latest. */
    public synchronized long earliestSeq() {
        BlockChange first = buf.peekFirst();
        return first == null ? seq + 1L : first.seq();
    }

    public synchronized BlockChange add(long tick, int x, int y, int z,
                                        String before, String after, String actor) {
        seq += 1L;
        BlockChange e = new BlockChange(seq, tick, x, y, z, before, after, actor);
        buf.addLast(e);
        while (buf.size() > capacity) {
            buf.removeFirst();
        }
        return e;
    }

    /** True when a consumer at {@code sinceSeq} can no longer be served continuously. */
    public synchronized boolean requiresReset(long sinceSeq) {
        return !buf.isEmpty() && sinceSeq < earliestSeq() - 1L;
    }

    public synchronized List<BlockChange> since(long sinceSeq, int max) {
        List<BlockChange> out = new ArrayList<>();
        for (BlockChange e : buf) {
            if (e.seq() > sinceSeq) {
                out.add(e);
                if (out.size() >= max) {
                    break;
                }
            }
        }
        return out;
    }
}
