package com.mcagent.observer.mixin;

import com.mcagent.observer.ObserverMod;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Records successful block placements by players as world events (before -> after), so the
 * observer contract covers placement as well as breaking (PlayerBlockBreakEvents). Read-only:
 * it only appends to the event log.
 */
@Mixin(BlockItem.class)
public abstract class BlockItemPlaceMixin {

    @Unique
    private BlockState mcagent$before;

    @Inject(method = "place", at = @At("HEAD"))
    private void mcagent$head(BlockPlaceContext ctx, CallbackInfoReturnable<InteractionResult> cir) {
        this.mcagent$before = ctx.getLevel().getBlockState(ctx.getClickedPos());
    }

    @Inject(method = "place", at = @At("RETURN"))
    private void mcagent$return(BlockPlaceContext ctx, CallbackInfoReturnable<InteractionResult> cir) {
        InteractionResult r = cir.getReturnValue();
        if (r == null || !r.consumesAction()) {
            return;
        }
        if (!(ctx.getPlayer() instanceof ServerPlayer player)) {
            return;
        }
        BlockPos pos = ctx.getClickedPos();
        BlockState after = ctx.getLevel().getBlockState(pos);
        ObserverMod.events.add(
                ObserverMod.tick,
                pos.getX(), pos.getY(), pos.getZ(),
                id(this.mcagent$before),
                id(after),
                player.getName().getString());
    }

    @Unique
    private static String id(BlockState st) {
        if (st == null) {
            return "unknown";
        }
        ResourceLocation rl = BuiltInRegistries.BLOCK.getKey(st.getBlock());
        return rl == null ? "unknown" : rl.toString();
    }
}
