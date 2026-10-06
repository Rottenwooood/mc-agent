package com.mcagent.observer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/** Bounded ring buffer of observed world events, read-only. */
public final class EventLog {

    public record BlockChange(long seq, long tick, int x, int y, int z,
                              String before, String after, String actor) {}

    private final int capacity;
    private final ArrayDeque<BlockChange> buf = new ArrayDeque<>();
    private long seq = 0L;

    public EventLog(int capacity) {
        this.capacity = Math.max(1, capacity);
    }

    public synchronized BlockChange add(long tick, int x, int y, int z,
                                        String before, String after, String actor) {
        seq += 1;
        BlockChange e = new BlockChange(seq, tick, x, y, z, before, after, actor);
        buf.addLast(e);
        while (buf.size() > capacity) {
            buf.removeFirst();
        }
        return e;
    }

    public synchronized long latestSeq() {
        return seq;
    }

    public synchronized List<BlockChange> since(long since, int max) {
        List<BlockChange> out = new ArrayList<>();
        for (BlockChange e : buf) {
            if (e.seq() > since) {
                out.add(e);
                if (out.size() >= max) {
                    break;
                }
            }
        }
        return out;
    }
}
