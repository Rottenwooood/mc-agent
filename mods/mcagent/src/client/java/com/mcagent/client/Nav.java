package com.mcagent.client;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/**
 * Bounded A* over the client's loaded chunks, producing a walking path on standable surfaces.
 * Movement is then executed through {@link ControlledInput} (player-legal input), never by
 * teleporting or writing velocity.
 *
 * <p>When {@code allowModify} is set, blocks that can be broken are treated as traversable (at an
 * extra cost) and the walker tunnels through them — mirroring the mineflayer backend's
 * {@code Movements.canDig}. Conservative by design: avoids fluids, steps up at most 1, falls at
 * most 3, never cuts diagonal corners, and gives up past a node/distance budget.
 */
public final class Nav {

    private Nav() {}

    /** True when a position is a place a player can stand (feet+head free, solid support). */
    public static boolean standable(ClientLevel level, BlockPos pos) {
        return standable(level, pos, false);
    }

    public static boolean standable(ClientLevel level, BlockPos pos, boolean allowModify) {
        if (!level.hasChunk(pos.getX() >> 4, pos.getZ() >> 4)) {
            return false;
        }
        return passableNav(level, pos, allowModify)
                && passableNav(level, pos.above(), allowModify)
                && !passable(level, pos.below());
    }

    /** Free of collision and of fluid (fluids are avoided for safety in pathing). */
    public static boolean passable(ClientLevel level, BlockPos pos) {
        BlockState st = level.getBlockState(pos);
        if (!st.getFluidState().isEmpty()) {
            return false;
        }
        return st.getCollisionShape(level, pos).isEmpty();
    }

    /** Passable, or breakable when terrain modification is allowed. */
    public static boolean passableNav(ClientLevel level, BlockPos pos, boolean allowModify) {
        if (passable(level, pos)) {
            return true;
        }
        return allowModify && breakable(level, pos);
    }

    /** A block a player can break (has a non-negative destroy speed; bedrock/portal are not). */
    public static boolean breakable(ClientLevel level, BlockPos pos) {
        BlockState st = level.getBlockState(pos);
        if (st.isAir() || !st.getFluidState().isEmpty()) {
            return false;
        }
        return st.getDestroySpeed(level, pos) >= 0;
    }

    public static List<BlockPos> findPath(ClientLevel level, BlockPos start, BlockPos goal,
                                          int range, int maxNodes, double maxDist) {
        return findPath(level, start, goal, range, maxNodes, maxDist, false);
    }

    /**
     * Find a walking path from {@code start} to within {@code range} (3D) of {@code goal}.
     *
     * @return ordered path of standable nodes, excluding {@code start}; empty if none found.
     */
    public static List<BlockPos> findPath(ClientLevel level, BlockPos start, BlockPos goal,
                                          int range, int maxNodes, double maxDist, boolean allowModify) {
        BlockPos s = nearestStandable(level, start, 3, allowModify);
        if (s == null) {
            return List.of();
        }
        final int goalRange = Math.max(0, range);

        Map<Long, Node> best = new HashMap<>();
        Set<Long> closed = new HashSet<>();
        PriorityQueue<Node> open = new PriorityQueue<>(Comparator.comparingDouble(n -> n.f));

        Node root = new Node(s, 0.0, heuristic(s, goal, goalRange), null);
        best.put(s.asLong(), root);
        open.add(root);

        int expanded = 0;
        Node found = null;
        while (!open.isEmpty() && expanded < maxNodes) {
            Node cur = open.poll();
            long key = cur.pos.asLong();
            if (closed.contains(key)) {
                continue;
            }
            closed.add(key);
            expanded++;

            if (dist3(cur.pos, goal) <= goalRange) {
                found = cur;
                break;
            }
            if (horizontalDist(cur.pos, s) > maxDist) {
                continue;
            }

            for (int dx = -1; dx <= 1; dx++) {
                for (int dz = -1; dz <= 1; dz++) {
                    if (dx == 0 && dz == 0) {
                        continue;
                    }
                    boolean diagonal = dx != 0 && dz != 0;
                    if (diagonal && (!clearColumn(level, cur.pos.offset(dx, 0, 0), allowModify)
                            || !clearColumn(level, cur.pos.offset(0, 0, dz), allowModify))) {
                        continue; // never cut a corner through a wall
                    }
                    // When tunnelling, only step down 1 (a larger fall would need to dig a block
                    // that is out of reach); without modification, falls of up to 3 are fine.
                    for (int dy = (allowModify ? -1 : -3); dy <= 1; dy++) {
                        BlockPos next = cur.pos.offset(dx, dy, dz);
                        if (!standable(level, next, allowModify) || !level.hasChunk(next.getX() >> 4, next.getZ() >> 4)) {
                            continue;
                        }
                        if (dy == 1 && !clearColumn(level, cur.pos, allowModify)) {
                            continue;
                        }
                        long nk = next.asLong();
                        if (closed.contains(nk)) {
                            continue;
                        }
                        double step = (diagonal ? 1.414 : 1.0)
                                + (dy > 0 ? 1.5 : (dy < 0 ? 0.5 * -dy : 0.0));
                        if (allowModify && !passable(level, next)) {
                            step += 4.0; // prefer going around over tunnelling
                        }
                        double g = cur.g + step;
                        Node prev = best.get(nk);
                        if (prev != null && prev.g <= g) {
                            continue;
                        }
                        Node node = new Node(next, g, heuristic(next, goal, goalRange), cur);
                        best.put(nk, node);
                        open.add(node);
                    }
                }
            }
        }

        if (found == null) {
            return List.of();
        }
        List<BlockPos> path = new ArrayList<>();
        for (Node n = found; n.parent != null; n = n.parent) {
            path.add(0, n.pos);
        }
        return path;
    }

    private static boolean clearColumn(ClientLevel level, BlockPos feet, boolean allowModify) {
        return passableNav(level, feet, allowModify) && passableNav(level, feet.above(), allowModify);
    }

    private static double heuristic(BlockPos a, BlockPos goal, int range) {
        double dx = a.getX() - goal.getX();
        double dz = a.getZ() - goal.getZ();
        double dy = a.getY() - goal.getY();
        double horiz = Math.max(0.0, Math.hypot(dx, dz) - range);
        return horiz + Math.abs(dy) * 0.5;
    }

    private static double horizontalDist(BlockPos a, BlockPos b) {
        double dx = a.getX() - b.getX();
        double dz = a.getZ() - b.getZ();
        return Math.hypot(dx, dz);
    }

    /** Euclidean distance between block positions (matches Mineflayer GoalNear semantics). */
    public static double dist3(BlockPos a, BlockPos b) {
        double dx = a.getX() - b.getX();
        double dy = a.getY() - b.getY();
        double dz = a.getZ() - b.getZ();
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    public static BlockPos nearestStandable(ClientLevel level, BlockPos origin, int radius) {
        return nearestStandable(level, origin, radius, false);
    }

    /** Closest standable node to {@code origin} within {@code radius} (inclusive of origin). */
    public static BlockPos nearestStandable(ClientLevel level, BlockPos origin, int radius, boolean allowModify) {
        if (standable(level, origin, allowModify)) {
            return origin;
        }
        for (int r = 1; r <= radius; r++) {
            for (int dy = -r; dy <= r; dy++) {
                for (int dx = -r; dx <= r; dx++) {
                    for (int dz = -r; dz <= r; dz++) {
                        if (Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz))) != r) {
                            continue;
                        }
                        BlockPos p = origin.offset(dx, dy, dz);
                        if (standable(level, p, allowModify)) {
                            return p;
                        }
                    }
                }
            }
        }
        return null;
    }

    private static final class Node {
        final BlockPos pos;
        final double g;
        final double f;
        final Node parent;

        Node(BlockPos pos, double g, double h, Node parent) {
            this.pos = pos;
            this.g = g;
            this.f = g + HEURISTIC_WEIGHT * h;
            this.parent = parent;
        }
    }

    /** Weighted A*: inflate the heuristic so the search is guided (greedy) and stays tractable
     * inside uniform solid rock, where every cell is traversable and a 1x heuristic explodes. */
    private static final double HEURISTIC_WEIGHT = 2.5;
}
