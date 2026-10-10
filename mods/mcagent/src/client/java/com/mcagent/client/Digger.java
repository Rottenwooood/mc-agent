package com.mcagent.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Robust block breaker shared by the dig primitive and the navigator's terrain-modifying mode.
 *
 * <p>It digs a <em>goal</em> block, deciding every tick which block to actually break: aim at the
 * goal centre and ray-cast from the eye; if the first solid block hit is the goal, break it; if it
 * is an occluder, break the occluder (tunnelling toward the goal); if the goal is non-solid the ray
 * misses and we break it directly. Face selection prefers an air-exposed face nearest the eye with
 * clear line of sight.
 *
 * <p>Destroy progress is <b>continuous</b>: the client's start/continue destroy sequence is only
 * restarted when the chosen block or face actually changes (never on a timer), otherwise the block
 * would never break.
 */
public final class Digger {

    /** Ticks on a single block before we give up (60s at 20tps). */
    private static final int BLOCK_TICKS_LIMIT = 1200;
    /** Ticks spent on the whole goal before we give up (handles plan oscillation). */
    private static final int GOAL_TICKS_LIMIT = 2400;

    private final Minecraft mc;
    private BlockPos goal;
    private BlockPos current;
    private Direction face;
    private boolean started;
    private int ticks;
    private int goalTicks;
    private String reason;

    public Digger(Minecraft mc) {
        this.mc = mc;
    }

    public boolean digging() {
        return goal != null;
    }

    public String reason() {
        return reason;
    }

    public void goal(BlockPos g) {
        if (g != null && g.equals(goal)) {
            return;
        }
        stop();
        goal = g;
        reason = null;
        goalTicks = 0;
    }

    public void stop() {
        stopDestroy();
        current = null;
        ticks = 0;
    }

    public void clear() {
        stop();
        goal = null;
        reason = null;
        goalTicks = 0;
    }

    private void stopDestroy() {
        if (started) {
            try {
                mc.gameMode.stopDestroyBlock();
            } catch (Throwable ignored) {
                // no-op
            }
            started = false;
        }
    }

    /** One tick of digging the goal; returns true when the goal is gone or unreachable. */
    public boolean tick(LocalPlayer p, PlayerActions actions) {
        if (goal == null || mc.level == null) {
            return true;
        }
        if (mc.level.getBlockState(goal).isAir()) {
            clear();
            return true;
        }
        // Re-aim every tick: the player may have been pushed.
        Aim.look(p, goal.getX() + 0.5, goal.getY() + 0.5, goal.getZ() + 0.5);

        Plan plan = plan(p);
        if (plan == null) {
            clear();
            if (reason == null) {
                reason = "no reachable face";
            }
            return true;
        }

        // Restart the destroy sequence ONLY when the target block/face changed.
        if (current == null || !current.equals(plan.block) || face != plan.face) {
            stopDestroy();
            current = plan.block;
            face = plan.face;
            ticks = 0;
        }
        if (!started) {
            actions.equipBestTool(mc.level.getBlockState(current));
            mc.gameMode.startDestroyBlock(current, face);
            started = true;
        }

        ticks++;
        goalTicks++;
        if (ticks > BLOCK_TICKS_LIMIT || goalTicks > GOAL_TICKS_LIMIT) {
            String stuck = current.toShortString();
            clear();
            reason = "dig stalled at " + stuck;
            return true;
        }

        mc.gameMode.continueDestroyBlock(current, face);
        p.swing(InteractionHand.MAIN_HAND);
        return false;
    }

    private static final class Plan {
        final BlockPos block;
        final Direction face;

        Plan(BlockPos block, Direction face) {
            this.block = block;
            this.face = face;
        }
    }

    /** Decide which block to break this tick. Sets {@link #reason} on failure. */
    private Plan plan(LocalPlayer p) {
        double reach = mc.gameMode.getPickRange() + 0.5;
        Vec3 eye = p.getEyePosition();
        Vec3 center = new Vec3(goal.getX() + 0.5, goal.getY() + 0.5, goal.getZ() + 0.5);
        BlockState goalState = mc.level.getBlockState(goal);

        if (goalState.getDestroySpeed(mc.level, goal) < 0) {
            reason = "unbreakable: " + goal.toShortString();
            return null;
        }

        BlockHitResult hit = mc.level.clip(new ClipContext(eye, center, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, p));
        if (hit.getType() == HitResult.Type.BLOCK) {
            BlockPos hp = hit.getBlockPos();
            double d = eye.distanceTo(hit.getLocation());
            if (hp.equals(goal)) {
                if (d <= reach) {
                    return new Plan(goal, hit.getDirection());
                }
                reason = "out_of_reach: " + goal.toShortString();
                return null;
            }
            // An occluder sits between the eye and the goal.
            BlockState occ = mc.level.getBlockState(hp);
            boolean breakable = occ.getDestroySpeed(mc.level, hp) >= 0;
            if (d <= reach && breakable) {
                return new Plan(hp, hit.getDirection());
            }
            // Occluder unreachable or unbreakable: fall back to an exposed goal face.
            Direction alt = bestExposedFace(p, goal, reach);
            if (alt != null) {
                return new Plan(goal, alt);
            }
            reason = breakable ? "out_of_reach: " + goal.toShortString() : "blocked by unbreakable: " + hp.toShortString();
            return null;
        }

        // Ray missed: goal is non-solid (grass/flower/torch/…) — break it directly.
        Direction f = bestExposedFace(p, goal, reach);
        return new Plan(goal, f != null ? f : Direction.UP);
    }

    /** Air-exposed face of {@code pos} whose centre is nearest the eye and has line of sight. */
    private Direction bestExposedFace(LocalPlayer p, BlockPos pos, double reach) {
        Vec3 eye = p.getEyePosition();
        double cx = pos.getX() + 0.5;
        double cy = pos.getY() + 0.5;
        double cz = pos.getZ() + 0.5;
        Direction best = null;
        double bestD = Double.MAX_VALUE;
        for (Direction d : Direction.values()) {
            BlockPos n = pos.relative(d);
            BlockState ns = mc.level.getBlockState(n);
            boolean exposed = ns.getCollisionShape(mc.level, n).isEmpty() && ns.getFluidState().isEmpty();
            if (!exposed) {
                continue;
            }
            Vec3 fc = new Vec3(cx + d.getStepX() * 0.5, cy + d.getStepY() * 0.5, cz + d.getStepZ() * 0.5);
            double dist = eye.distanceTo(fc);
            if (dist > reach || dist >= bestD) {
                continue;
            }
            BlockHitResult h = mc.level.clip(new ClipContext(eye, fc, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, p));
            boolean clear = h.getType() == HitResult.Type.MISS || h.getBlockPos().equals(pos);
            if (clear) {
                best = d;
                bestD = dist;
            }
        }
        return best;
    }
}
