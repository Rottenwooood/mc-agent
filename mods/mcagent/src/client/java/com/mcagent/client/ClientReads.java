package com.mcagent.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Optional;

/**
 * Client-side reads (observed, never authoritative). These mirror the read half of ControlPort;
 * the authoritative WorldPort stays on the server-side observer.
 */
public final class ClientReads {

    private final Minecraft mc;

    public ClientReads(Minecraft mc) {
        this.mc = mc;
    }

    public JsonObject raycast(JsonObject args) {
        LocalPlayer p = mc.player;
        ClientLevel level = mc.level;
        if (p == null || level == null) {
            return Wire.rejected("no player");
        }
        double max = args.has("maxDistance") ? args.get("maxDistance").getAsDouble() : 5.0;
        Vec3 from = p.getEyePosition();
        Vec3 to = from.add(p.getLookAngle().scale(max));
        JsonObject out = new JsonObject();

        BlockHitResult bh = level.clip(new ClipContext(from, to, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, p));
        if (bh.getType() == HitResult.Type.BLOCK) {
            JsonObject b = new JsonObject();
            BlockPos pos = bh.getBlockPos();
            b.add("pos", Wire.vec(pos.getX(), pos.getY(), pos.getZ()));
            b.addProperty("name", PlayerActions.itemName(
                    new ItemStack(level.getBlockState(pos).getBlock().asItem())));
            out.add("block", b);
        }

        Entity nearest = null;
        double best = Double.MAX_VALUE;
        for (Entity e : level.entitiesForRendering()) {
            if (e == p) {
                continue;
            }
            Optional<Vec3> hit = e.getBoundingBox().inflate(0.3).clip(from, to);
            if (hit.isPresent()) {
                double d = from.distanceToSqr(hit.get());
                if (d < best) {
                    best = d;
                    nearest = e;
                }
            }
        }
        if (nearest != null) {
            JsonObject e = new JsonObject();
            e.addProperty("id", nearest.getId());
            ResourceLocation rl = BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType());
            e.addProperty("type", rl == null ? "unknown" : rl.toString());
            out.add("entity", e);
        }
        return Wire.result(out);
    }

    public JsonObject worldInfo() {
        ClientLevel level = mc.level;
        if (level == null) {
            return Wire.rejected("no world");
        }
        JsonObject o = new JsonObject();
        o.addProperty("time", level.getDayTime());
        o.addProperty("raining", level.isRaining());
        o.addProperty("dimension", level.dimension().location().toString());
        return Wire.result(o);
    }

    public JsonObject canReach(JsonObject args) {
        LocalPlayer p = mc.player;
        ClientLevel level = mc.level;
        if (p == null || level == null) {
            return Wire.result(new com.google.gson.JsonPrimitive(false));
        }
        JsonArray a = args.getAsJsonArray("pos");
        BlockPos goal = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
        int range = args.has("range") ? args.get("range").getAsInt() : 1;
        double hd = Math.hypot(p.getX() - (goal.getX() + 0.5), p.getZ() - (goal.getZ() + 0.5));
        boolean ok = hd <= Math.max(0.5, range)
                || !Nav.findPath(level, p.blockPosition(), goal, Math.max(1, range), 6000, 128.0).isEmpty();
        return Wire.result(new com.google.gson.JsonPrimitive(ok));
    }

    public JsonObject canSee(JsonObject args) {
        LocalPlayer p = mc.player;
        ClientLevel level = mc.level;
        if (p == null || level == null) {
            return Wire.result(new com.google.gson.JsonPrimitive(false));
        }
        JsonArray a = args.getAsJsonArray("pos");
        BlockPos pos = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
        Vec3 from = p.getEyePosition();
        Vec3 to = new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
        BlockHitResult bh = level.clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, p));
        boolean visible = bh.getType() == HitResult.Type.MISS || bh.getBlockPos().equals(pos);
        return Wire.result(new com.google.gson.JsonPrimitive(visible));
    }

    public JsonObject lookupRecipe(JsonObject args) {
        ClientLevel level = mc.level;
        String name = args.has("item") ? args.get("item").getAsString() : null;
        if (level == null || name == null) {
            return Wire.result(new JsonArray());
        }
        Item target = PlayerActions.itemByName(name);
        if (target == null) {
            return Wire.result(new JsonArray());
        }
        JsonArray out = new JsonArray();
        List<CraftingRecipe> recipes = level.getRecipeManager().getAllRecipesFor(RecipeType.CRAFTING);
        for (CraftingRecipe r : recipes) {
            ItemStack result = r.getResultItem(level.registryAccess());
            if (!result.is(target)) {
                continue;
            }
            JsonObject entry = new JsonObject();
            JsonObject res = new JsonObject();
            res.addProperty("item", PlayerActions.itemName(result));
            res.addProperty("count", result.getCount());
            entry.add("result", res);
            JsonArray ings = new JsonArray();
            for (Ingredient ing : r.getIngredients()) {
                ItemStack[] items = ing.getItems();
                if (items.length == 0) {
                    continue;
                }
                JsonObject it = new JsonObject();
                it.addProperty("item", PlayerActions.itemName(items[0]));
                it.addProperty("count", 1);
                ings.add(it);
            }
            entry.add("ingredients", ings);
            boolean requiresTable;
            if (r instanceof ShapedRecipe sr) {
                requiresTable = sr.getWidth() > 2 || sr.getHeight() > 2;
            } else {
                requiresTable = r.getIngredients().size() > 4;
            }
            entry.addProperty("requiresTable", requiresTable);
            out.add(entry);
        }
        return Wire.result(out);
    }
}
