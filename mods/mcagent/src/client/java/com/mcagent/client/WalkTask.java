package com.mcagent.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;

import java.util.List;

/**
 * Walks the local player along a bounded A* path by writing movement input (never by setting
 * position/velocity). Recomputes on a dynamic goal (follow) and detects being stuck.
 */
public final class WalkTask extends ControlTask {

    /** Supplies the current target block; return {@code null} to give up this tick. */
    public interface GoalSource {
        BlockPos target(LocalPlayer p, ClientLevel level);
    }

    private static final int MAX_NODES = 6000;
    private static final double MAX_DIST = 128.0;

    private final Minecraft mc;
    private final ControlledInput input;
    private final GoalSource goal;
    private final int range;
    private final long stopAtMs;

    private List<BlockPos> path = List.of();
    private int index;
    private double lastX;
    private double lastZ;
    private int sinceProgress;
    private int recomputes;

    public WalkTask(Minecraft mc, ControlledInput input, String label, long budgetMs,
                    GoalSource goal, int range, long stopAtMs) {
        super(label, budgetMs);
        this.mc = mc;
        this.input = input;
        this.goal = goal;
        this.range = Math.max(0, range);
        this.stopAtMs = stopAtMs;
    }

    @Override
    public boolean step() {
        LocalPlayer p = mc.player;
        ClientLevel level = mc.level;
        if (p == null || level == null) {
            input.reset();
            complete(Wire.rejected("no player in world"));
            return true;
        }
        if (stopAtMs > 0 && System.currentTimeMillis() >= stopAtMs) {
            input.reset();
            complete(Wire.accepted("duration elapsed"));
            return true;
        }

        BlockPos target = goal.target(p, level);
        if (target == null) {
            input.reset();
            complete(Wire.rejected("no target"));
            return true;
        }

        double hd = Math.hypot(p.getX() - (target.getX() + 0.5), p.getZ() - (target.getZ() + 0.5));
        if (hd <= Math.max(0.5, range)) {
            input.reset();
            complete(Wire.accepted("path resolved"));
            return true;
        }

        if (path.isEmpty() || index >= path.size()) {
            path = Nav.findPath(level, p.blockPosition(), target, Math.max(1, range), MAX_NODES, MAX_DIST);
            index = 0;
            if (path.isEmpty()) {
                input.reset();
                complete(Wire.rejected("no path to target"));
                return true;
            }
        }

        BlockPos next = path.get(index);
        double dx = (next.getX() + 0.5) - p.getX();
        double dz = (next.getZ() + 0.5) - p.getZ();
        if (Math.hypot(dx, dz) < 0.75 && Math.abs(next.getY() - p.getY()) < 1.6) {
            index++;
            return false;
        }

        Aim.look(p, next.getX() + 0.5, next.getY() + 0.5, next.getZ() + 0.5);
        input.move(1.0F, 0.0F);
        input.jumping = next.getY() > p.getY() + 0.6;
        input.shiftKeyDown = false;

        // Stuck detection: if we barely moved in a while, recompute; give up after repeated stalls.
        if (Math.hypot(p.getX() - lastX, p.getZ() - lastZ) < 0.05) {
            sinceProgress++;
        } else {
            sinceProgress = 0;
            lastX = p.getX();
            lastZ = p.getZ();
        }
        if (sinceProgress > 40) {
            sinceProgress = 0;
            recomputes++;
            path = List.of();
            if (recomputes > 3) {
                input.reset();
                complete(Wire.rejected("stuck: could not reach target"));
                return true;
            }
        }
        return false;
    }

    @Override
    protected void onCancel() {
        input.reset();
    }
}
