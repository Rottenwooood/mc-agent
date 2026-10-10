package com.mcagent.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;

import java.util.ArrayList;
import java.util.List;

/**
 * Walks the local player along a bounded A* path by writing movement input (never by setting
 * position/velocity). Recomputes on a dynamic goal (follow) and detects being stuck.
 *
 * <p>When {@code allowModify} is set it tunnels through terrain: a solid block in the column of
 * the next path node is broken with the shared {@link Digger} before moving on.
 */
public final class WalkTask extends ControlTask {

    /** Supplies the current target block; return {@code null} to give up this tick. */
    public interface GoalSource {
        BlockPos target(LocalPlayer p, ClientLevel level);
    }

    private static final int MAX_NODES = 6000;
    private static final double MAX_DIST = 128.0;

    private final Minecraft mc;
    private final PlayerActions actions;
    private final ControlledInput input;
    private final GoalSource goal;
    private final int range;
    private final long stopAtMs;
    private final boolean allowModify;
    private final Digger digger;

    private List<BlockPos> path = List.of();
    private int index;
    private double lastX;
    private double lastZ;
    private int sinceProgress;
    private int recomputes;
    private int settle;

    public WalkTask(Minecraft mc, PlayerActions actions, ControlledInput input, String label, long budgetMs,
                    GoalSource goal, int range, long stopAtMs, boolean allowModify) {
        super(label, budgetMs);
        this.mc = mc;
        this.actions = actions;
        this.input = input;
        this.goal = goal;
        this.range = Math.max(0, range);
        this.stopAtMs = stopAtMs;
        this.allowModify = allowModify;
        this.digger = new Digger(mc);
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
            digger.stop();
            input.reset();
            complete(Wire.accepted("duration elapsed"));
            return true;
        }

        BlockPos target = goal.target(p, level);
        if (target == null) {
            digger.stop();
            input.reset();
            complete(Wire.rejected("no target"));
            return true;
        }

        BlockPos pblock = p.blockPosition();
        if (Nav.dist3(pblock, target) <= Math.max(0, range)) {
            digger.stop();
            input.reset();
            if (p.onGround()) {
                settle++;
                if (settle >= 2) {
                    complete(Wire.accepted("path resolved"));
                    return true;
                }
            } else {
                settle = 0;
            }
            return false;
        }
        settle = 0;

        if (path.isEmpty() || index >= path.size()) {
            path = Nav.findPath(level, pblock, target, Math.max(0, range), MAX_NODES, MAX_DIST, allowModify);
            index = 0;
            if (path.isEmpty()) {
                digger.stop();
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

        // Terrain-modifying mode: clear the whole volume the player's 2-tall body needs to pass —
        // its own column, the next column, and the two corner columns when stepping diagonally.
        if (allowModify) {
            BlockPos here = p.blockPosition();
            int sx = Integer.signum(next.getX() - here.getX());
            int sz = Integer.signum(next.getZ() - here.getZ());
            BlockPos dig = null;
            for (BlockPos c : clearCells(here, next, sx, sz)) {
                if (!Nav.passable(level, c)) {
                    dig = c;
                    break;
                }
            }
            if (dig != null) {
                input.reset();
                digger.goal(dig);
                digger.tick(p, actions);
                // Breaking a block IS progress: don't let the stuck detector fire while digging.
                sinceProgress = 0;
                lastX = p.getX();
                lastZ = p.getZ();
                return false;
            }
            digger.stop();
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
                digger.stop();
                input.reset();
                complete(Wire.rejected("stuck: could not reach target"));
                return true;
            }
        }
        return false;
    }

    @Override
    protected void onCancel() {
        digger.stop();
        input.reset();
    }

    /**
     * Blocks the player's 2-tall body must have free to step from {@code here} to {@code next}:
     * both columns across the whole vertical span (so head clearance is not missed on a step
     * up/down), plus the two corner columns when stepping diagonally.
     */
    private static List<BlockPos> clearCells(BlockPos here, BlockPos next, int sx, int sz) {
        List<BlockPos> out = new ArrayList<>();
        int lo = Math.min(here.getY(), next.getY());
        int hi = Math.max(here.getY(), next.getY()) + 1;
        for (int y = lo; y <= hi; y++) {
            out.add(new BlockPos(here.getX(), y, here.getZ()));
            out.add(new BlockPos(next.getX(), y, next.getZ()));
            if (sx != 0 && sz != 0) {
                out.add(new BlockPos(here.getX() + sx, y, here.getZ()));
                out.add(new BlockPos(here.getX(), y, here.getZ() + sz));
            }
        }
        return out;
    }
}
