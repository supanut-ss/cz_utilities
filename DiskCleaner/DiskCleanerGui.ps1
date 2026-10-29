#Requires -Version 5.1
<#
.SYNOPSIS
    Window for DiskCleaner: tick categories, scan, clean, manage custom folders.

.DESCRIPTION
    Windows 11 style front end for the DiskCleaner engine. Categories are scanned
    on open and shown in groups with their size; tick what to clean and press
    "Clean selected". Choices, the age filter, drive type and custom folders are
    remembered in %LOCALAPPDATA%\DiskCleaner\settings.json. Follows the system
    light/dark theme; cleaning runs in the background so the window stays responsive.

    Keyboard: F5 rescans, Esc closes the confirmation dialog, Space toggles the focused checkbox.

.PARAMETER Theme
    System (default), Light or Dark.

.PARAMETER SnapshotPath
    Render the window to a PNG after the first scan, then exit (for automated checks).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -STA -File .\DiskCleanerGui.ps1
#>
param(
    [ValidateSet('System', 'Light', 'Dark')]
    [string]$Theme = 'System',
    [string]$SnapshotPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -File `"$PSCommandPath`" -Theme $Theme"
    return
}

try {
# DiskCleaner.exe runs this script from memory and passes the core as text ($DiskCleanerCoreText).
if ($DiskCleanerCoreText) { . ([scriptblock]::Create($DiskCleanerCoreText)) }
else { . (Join-Path $PSScriptRoot 'DiskCleaner.Core.ps1') }

#region Theme -------------------------------------------------------------------
# Semantic color tokens; every pair used for text meets WCAG AA (4.5:1) in both themes.
$Palettes = @{
    Light = [ordered]@{
        Bg = '#F3F3F3'; Surface = '#FFFFFF'; SurfaceAlt = '#F7F7F7'; RowHover = '#F2F6FC'
        Stroke = '#E5E5E5'; StrokeStrong = '#BDBDBD'
        ControlFill = '#FDFDFD'; HoverOverlay = '#0D000000'; PressedOverlay = '#1A000000'
        Text = '#1B1B1B'; TextSecondary = '#5D5D5D'; TextTertiary = '#6B6B6B'
        Accent = '#005FB8'; OnAccent = '#FFFFFF'; AccentSoft = '#E5EFF9'
        Danger = '#C42B1C'; OnDanger = '#FFFFFF'
        SuccessText = '#0E700E'; SuccessBg = '#DFF6DD'; WarningText = '#8A5300'; WarningBg = '#FFF4CE'
        ErrorText = '#B3261E'; ErrorBg = '#FDE7E9'; MutedBg = '#EFEFEF'
        Track = '#E1E1E1'; SegmentTrack = '#ECECEC'; SegmentSelected = '#FFFFFF'; ScrollThumb = '#8A8A8A'; Scrim = '#59000000'
    }
    Dark = [ordered]@{
        Bg = '#202020'; Surface = '#2B2B2B'; SurfaceAlt = '#262626'; RowHover = '#33373E'
        Stroke = '#3B3B3B'; StrokeStrong = '#6A6A6A'
        ControlFill = '#323232'; HoverOverlay = '#14FFFFFF'; PressedOverlay = '#0AFFFFFF'
        Text = '#FFFFFF'; TextSecondary = '#CFCFCF'; TextTertiary = '#A8A8A8'
        Accent = '#60CDFF'; OnAccent = '#000000'; AccentSoft = '#1D3443'
        Danger = '#C42B1C'; OnDanger = '#FFFFFF'
        SuccessText = '#6CCB5F'; SuccessBg = '#2A3A26'; WarningText = '#FCE100'; WarningBg = '#433519'
        ErrorText = '#FF99A4'; ErrorBg = '#442726'; MutedBg = '#3A3A3A'
        Track = '#4A4A4A'; SegmentTrack = '#1E1E1E'; SegmentSelected = '#454545'; ScrollThumb = '#9A9A9A'; Scrim = '#80000000'
    }
}

function Get-SystemTheme {
    try {
        $light = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme
        if ($light -eq 0) { return 'Dark' }
    } catch { }
    'Light'
}

$ThemeName = if ($Theme -eq 'System') { Get-SystemTheme } else { $Theme }
$Animate = [Windows.SystemParameters]::ClientAreaAnimation # off when the user turned animations off
#endregion

#region Layout ------------------------------------------------------------------
$xamlText = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Disk Cleaner" Width="1240" Height="820" MinWidth="980" MinHeight="620"
        WindowStartupLocation="CenterScreen" UseLayoutRounding="True" SnapsToDevicePixels="True"
        FontFamily="Segoe UI Variable Text, Segoe UI" FontSize="14" TextOptions.TextFormattingMode="Display"
        Background="{DynamicResource Bg}" Foreground="{DynamicResource Text}">
  <Window.Resources>
    <!--BRUSHES-->
    <FontFamily x:Key="IconFont">Segoe Fluent Icons, Segoe MDL2 Assets</FontFamily>
    <FontFamily x:Key="DisplayFont">Segoe UI Variable Display, Segoe UI</FontFamily>
    <BooleanToVisibilityConverter x:Key="BoolToVis"/>

    <!-- Type ramp -->
    <Style x:Key="Caption" TargetType="TextBlock">
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Foreground" Value="{StaticResource TextSecondary}"/>
    </Style>
    <Style x:Key="Body" TargetType="TextBlock">
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Foreground" Value="{StaticResource Text}"/>
    </Style>
    <Style x:Key="BodyStrong" TargetType="TextBlock" BasedOn="{StaticResource Body}">
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <Style x:Key="Subtitle" TargetType="TextBlock">
      <Setter Property="FontFamily" Value="{StaticResource DisplayFont}"/>
      <Setter Property="FontSize" Value="20"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Foreground" Value="{StaticResource Text}"/>
    </Style>
    <Style x:Key="Display" TargetType="TextBlock" BasedOn="{StaticResource Subtitle}">
      <Setter Property="FontSize" Value="38"/>
      <Setter Property="Typography.NumeralAlignment" Value="Tabular"/>
    </Style>
    <Style x:Key="Icon" TargetType="TextBlock">
      <Setter Property="FontFamily" Value="{StaticResource IconFont}"/>
      <Setter Property="FontSize" Value="16"/>
      <Setter Property="VerticalAlignment" Value="Center"/>
    </Style>

    <!-- Surfaces -->
    <Style x:Key="Card" TargetType="Border">
      <Setter Property="Background" Value="{StaticResource Surface}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Stroke}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="8"/>
      <Setter Property="Padding" Value="20"/>
    </Style>
    <Style x:Key="FocusRing">
      <Setter Property="Control.Template">
        <Setter.Value>
          <ControlTemplate>
            <Rectangle Margin="-3" RadiusX="7" RadiusY="7" Stroke="{StaticResource Text}" StrokeThickness="2"/>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Buttons: one template, hover/press via a translucent overlay so every variant gets state feedback -->
    <Style TargetType="Button">
      <Setter Property="FocusVisualStyle" Value="{StaticResource FocusRing}"/>
      <Setter Property="Background" Value="{StaticResource ControlFill}"/>
      <Setter Property="Foreground" Value="{StaticResource Text}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Stroke}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="14,0"/>
      <Setter Property="MinHeight" Value="34"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="HorizontalContentAlignment" Value="Center"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Grid>
              <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                      BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="6"/>
              <Border x:Name="Overlay" CornerRadius="6" Background="Transparent"/>
              <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}"
                                VerticalAlignment="Center" RecognizesAccessKey="True"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Overlay" Property="Background" Value="{StaticResource HoverOverlay}"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Overlay" Property="Background" Value="{StaticResource PressedOverlay}"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.45"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="AccentButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Background" Value="{StaticResource Accent}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Accent}"/>
      <Setter Property="Foreground" Value="{StaticResource OnAccent}"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <Style x:Key="DangerButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Background" Value="{StaticResource Danger}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Danger}"/>
      <Setter Property="Foreground" Value="{StaticResource OnDanger}"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <Style x:Key="SubtleButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderBrush" Value="Transparent"/>
      <Setter Property="Padding" Value="10,0"/>
      <Setter Property="MinHeight" Value="32"/>
    </Style>
    <Style x:Key="LinkButton" TargetType="Button" BasedOn="{StaticResource SubtleButton}">
      <Setter Property="Foreground" Value="{StaticResource Accent}"/>
    </Style>
    <Style x:Key="IconButton" TargetType="Button" BasedOn="{StaticResource SubtleButton}">
      <Setter Property="Width" Value="34"/>
      <Setter Property="Height" Value="34"/>
      <Setter Property="Padding" Value="0"/>
      <Setter Property="FontFamily" Value="{StaticResource IconFont}"/>
      <Setter Property="FontSize" Value="16"/>
      <Setter Property="Foreground" Value="{StaticResource TextSecondary}"/>
    </Style>

    <!-- Checkbox -->
    <Style TargetType="CheckBox">
      <Setter Property="FocusVisualStyle" Value="{StaticResource FocusRing}"/>
      <Setter Property="Foreground" Value="{StaticResource Text}"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="VerticalAlignment" Value="Center"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <!-- Grid (not StackPanel) so a long label gets a width and wraps -->
            <Grid Background="Transparent">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
              </Grid.ColumnDefinitions>
              <Grid Width="20" Height="20" VerticalAlignment="Top">
                <Border x:Name="Box" CornerRadius="4" Background="{StaticResource ControlFill}"
                        BorderBrush="{StaticResource StrokeStrong}" BorderThickness="1"/>
                <Border x:Name="Overlay" CornerRadius="4" Background="Transparent"/>
                <TextBlock x:Name="Mark" Text="&#xE73E;" FontFamily="{StaticResource IconFont}" FontSize="12"
                           Foreground="{StaticResource OnAccent}" HorizontalAlignment="Center" VerticalAlignment="Center" Visibility="Collapsed"/>
              </Grid>
              <ContentPresenter x:Name="Label" Grid.Column="1" Margin="8,1,0,0" VerticalAlignment="Top"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Box" Property="Background" Value="{StaticResource Accent}"/>
                <Setter TargetName="Box" Property="BorderBrush" Value="{StaticResource Accent}"/>
                <Setter TargetName="Mark" Property="Visibility" Value="Visible"/>
              </Trigger>
              <Trigger Property="IsChecked" Value="{x:Null}">
                <Setter TargetName="Box" Property="Background" Value="{StaticResource Accent}"/>
                <Setter TargetName="Box" Property="BorderBrush" Value="{StaticResource Accent}"/>
                <Setter TargetName="Mark" Property="Text" Value="&#xE738;"/>
                <Setter TargetName="Mark" Property="Visibility" Value="Visible"/>
              </Trigger>
              <Trigger Property="Content" Value="{x:Null}">
                <Setter TargetName="Label" Property="Visibility" Value="Collapsed"/>
              </Trigger>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Overlay" Property="Background" Value="{StaticResource HoverOverlay}"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.45"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Segmented control (radio buttons) -->
    <Style x:Key="Segment" TargetType="RadioButton">
      <Setter Property="FocusVisualStyle" Value="{StaticResource FocusRing}"/>
      <Setter Property="Foreground" Value="{StaticResource Text}"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="RadioButton">
            <Border x:Name="Bd" CornerRadius="5" Padding="10,6" Background="Transparent" BorderThickness="1" BorderBrush="Transparent">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Bd" Property="Background" Value="{StaticResource HoverOverlay}"/>
              </Trigger>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Bd" Property="Background" Value="{StaticResource SegmentSelected}"/>
                <Setter TargetName="Bd" Property="BorderBrush" Value="{StaticResource Stroke}"/>
                <Setter Property="FontWeight" Value="SemiBold"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.45"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Slider -->
    <Style x:Key="SliderFill" TargetType="RepeatButton">
      <Setter Property="Focusable" Value="False"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="RepeatButton">
            <Border Height="4" CornerRadius="2" Background="{StaticResource Accent}"/>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="SliderRest" TargetType="RepeatButton">
      <Setter Property="Focusable" Value="False"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="RepeatButton">
            <Border Background="Transparent"/>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="SliderThumb" TargetType="Thumb">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Thumb">
            <Grid Width="20" Height="20" Background="Transparent">
              <Ellipse Fill="{StaticResource ControlFill}" Stroke="{StaticResource StrokeStrong}" StrokeThickness="1"/>
              <Ellipse x:Name="Dot" Width="12" Height="12" Fill="{StaticResource Accent}"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Dot" Property="Width" Value="14"/>
                <Setter TargetName="Dot" Property="Height" Value="14"/>
              </Trigger>
              <Trigger Property="IsDragging" Value="True">
                <Setter TargetName="Dot" Property="Width" Value="10"/>
                <Setter TargetName="Dot" Property="Height" Value="10"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="Slider">
      <Setter Property="FocusVisualStyle" Value="{StaticResource FocusRing}"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Slider">
            <Grid Height="24" Background="Transparent">
              <Border Height="4" CornerRadius="2" Background="{StaticResource Track}" VerticalAlignment="Center"/>
              <Track x:Name="PART_Track">
                <Track.DecreaseRepeatButton><RepeatButton Style="{StaticResource SliderFill}" Command="Slider.DecreaseLarge"/></Track.DecreaseRepeatButton>
                <Track.IncreaseRepeatButton><RepeatButton Style="{StaticResource SliderRest}" Command="Slider.IncreaseLarge"/></Track.IncreaseRepeatButton>
                <Track.Thumb><Thumb Style="{StaticResource SliderThumb}"/></Track.Thumb>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Progress / meter bars -->
    <Style TargetType="ProgressBar">
      <Setter Property="Foreground" Value="{StaticResource Accent}"/>
      <Setter Property="Height" Value="4"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ProgressBar">
            <Grid ClipToBounds="True">
              <Border x:Name="PART_Track" CornerRadius="2" Background="{StaticResource Track}"/>
              <Border x:Name="PART_Indicator" CornerRadius="2" Background="{TemplateBinding Foreground}" HorizontalAlignment="Left"/>
              <Border x:Name="Shuttle" CornerRadius="2" Background="{TemplateBinding Foreground}" Width="140"
                      HorizontalAlignment="Left" Visibility="Collapsed">
                <Border.RenderTransform><TranslateTransform x:Name="ShuttleX" X="-140"/></Border.RenderTransform>
              </Border>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsIndeterminate" Value="True">
                <Setter TargetName="PART_Indicator" Property="Visibility" Value="Collapsed"/>
                <Setter TargetName="Shuttle" Property="Visibility" Value="Visible"/>
                <Trigger.EnterActions>
                  <BeginStoryboard x:Name="Run">
                    <Storyboard RepeatBehavior="Forever">
                      <DoubleAnimation Storyboard.TargetName="ShuttleX" Storyboard.TargetProperty="X" From="-140" To="420" Duration="0:0:1.3">
                        <DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction>
                      </DoubleAnimation>
                    </Storyboard>
                  </BeginStoryboard>
                </Trigger.EnterActions>
                <Trigger.ExitActions><StopStoryboard BeginStoryboardName="Run"/></Trigger.ExitActions>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Thin scrollbars -->
    <Style x:Key="ScrollThumbStyle" TargetType="Thumb">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Thumb">
            <Border x:Name="T" CornerRadius="3" Background="{StaticResource ScrollThumb}" Opacity="0.55"/>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="T" Property="Opacity" Value="0.9"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="ScrollPage" TargetType="RepeatButton">
      <Setter Property="Focusable" Value="False"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="RepeatButton"><Border Background="Transparent"/></ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="12"/>
      <Setter Property="MinWidth" Value="12"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Track x:Name="PART_Track" IsDirectionReversed="True" Margin="3,4">
              <Track.DecreaseRepeatButton><RepeatButton Style="{StaticResource ScrollPage}" Command="ScrollBar.PageUpCommand"/></Track.DecreaseRepeatButton>
              <Track.IncreaseRepeatButton><RepeatButton Style="{StaticResource ScrollPage}" Command="ScrollBar.PageDownCommand"/></Track.IncreaseRepeatButton>
              <Track.Thumb><Thumb Style="{StaticResource ScrollThumbStyle}"/></Track.Thumb>
            </Track>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
      <Style.Triggers>
        <Trigger Property="Orientation" Value="Horizontal">
          <Setter Property="Width" Value="Auto"/>
          <Setter Property="MinWidth" Value="0"/>
          <Setter Property="Height" Value="12"/>
          <Setter Property="MinHeight" Value="12"/>
          <Setter Property="Template">
            <Setter.Value>
              <ControlTemplate TargetType="ScrollBar">
                <Track x:Name="PART_Track" Margin="4,3">
                  <Track.DecreaseRepeatButton><RepeatButton Style="{StaticResource ScrollPage}" Command="ScrollBar.PageLeftCommand"/></Track.DecreaseRepeatButton>
                  <Track.IncreaseRepeatButton><RepeatButton Style="{StaticResource ScrollPage}" Command="ScrollBar.PageRightCommand"/></Track.IncreaseRepeatButton>
                  <Track.Thumb><Thumb Style="{StaticResource ScrollThumbStyle}"/></Track.Thumb>
                </Track>
              </ControlTemplate>
            </Setter.Value>
          </Setter>
        </Trigger>
      </Style.Triggers>
    </Style>

    <Style TargetType="ToolTip">
      <Setter Property="Foreground" Value="{StaticResource Text}"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ToolTip">
            <Border Background="{StaticResource Surface}" BorderBrush="{StaticResource Stroke}" BorderThickness="1"
                    CornerRadius="6" Padding="8,5" MaxWidth="360">
              <ContentPresenter>
                <ContentPresenter.Resources>
                  <Style TargetType="TextBlock"><Setter Property="TextWrapping" Value="Wrap"/></Style>
                </ContentPresenter.Resources>
              </ContentPresenter>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- One category row: whole row toggles selection, status as a labelled chip, size with a relative bar -->
    <DataTemplate x:Key="RowTemplate">
      <Border x:Name="RowBorder" Margin="8,1" Padding="12,7" CornerRadius="6" Background="Transparent" Cursor="Hand">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="200"/>
            <ColumnDefinition Width="76"/>
          </Grid.ColumnDefinitions>
          <CheckBox IsChecked="{Binding IsSelected, UpdateSourceTrigger=PropertyChanged}" IsEnabled="{Binding IsAvailable}"
                    AutomationProperties.Name="{Binding Name}" AutomationProperties.HelpText="{Binding Description}"/>
          <Border Grid.Column="1" Width="34" Height="34" CornerRadius="8" Margin="14,0,12,0" Background="{StaticResource AccentSoft}">
            <TextBlock Text="{Binding Icon}" Style="{StaticResource Icon}" FontSize="16" Foreground="{StaticResource Accent}" HorizontalAlignment="Center"/>
          </Border>
          <StackPanel Grid.Column="2" VerticalAlignment="Center">
            <TextBlock Text="{Binding Name}" Style="{StaticResource BodyStrong}" TextTrimming="CharacterEllipsis"/>
            <TextBlock Text="{Binding Description}" Style="{StaticResource Caption}" TextTrimming="CharacterEllipsis"
                       ToolTip="{Binding Description}" Margin="0,2,0,0"/>
          </StackPanel>
          <Border x:Name="Chip" Grid.Column="3" CornerRadius="11" Padding="9,3" Margin="12,0,4,0" VerticalAlignment="Center" Visibility="Collapsed">
            <StackPanel Orientation="Horizontal">
              <TextBlock x:Name="ChipIcon" Style="{StaticResource Icon}" FontSize="11" Margin="0,0,5,0"/>
              <TextBlock x:Name="ChipText" Text="{Binding Status}" FontSize="12"/>
            </StackPanel>
          </Border>
          <StackPanel Grid.Column="4" VerticalAlignment="Center" Margin="16,0,0,0">
            <Grid>
              <TextBlock Text="{Binding FilesLabel}" Style="{StaticResource Caption}" VerticalAlignment="Bottom" Margin="0,0,0,1" Typography.NumeralAlignment="Tabular"/>
              <TextBlock Text="{Binding SizeText}" Style="{StaticResource BodyStrong}" HorizontalAlignment="Right" Typography.NumeralAlignment="Tabular"/>
            </Grid>
            <ProgressBar Maximum="1" Value="{Binding SizeRatio, Mode=OneWay}" Margin="0,6,0,0"
                         Visibility="{Binding HasSize, Converter={StaticResource BoolToVis}}" IsTabStop="False"/>
          </StackPanel>
          <StackPanel Grid.Column="5" Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
            <Button Tag="open" Content="&#xE838;" Style="{StaticResource IconButton}" ToolTip="Open folder"
                    AutomationProperties.Name="{Binding Name, StringFormat='Open folder of {0}'}"
                    Visibility="{Binding CanOpen, Converter={StaticResource BoolToVis}}"/>
            <Button Tag="remove" Content="&#xE74D;" Style="{StaticResource IconButton}" ToolTip="Remove from list"
                    AutomationProperties.Name="{Binding Name, StringFormat='Remove {0} from list'}"
                    Visibility="{Binding IsCustom, Converter={StaticResource BoolToVis}}"/>
          </StackPanel>
        </Grid>
      </Border>
      <DataTemplate.Triggers>
        <Trigger SourceName="RowBorder" Property="IsMouseOver" Value="True">
          <Setter TargetName="RowBorder" Property="Background" Value="{StaticResource RowHover}"/>
        </Trigger>
        <DataTrigger Binding="{Binding IsAvailable}" Value="False">
          <Setter TargetName="RowBorder" Property="Cursor" Value="Arrow"/>
        </DataTrigger>
        <DataTrigger Binding="{Binding StatusKind}" Value="warn">
          <Setter TargetName="Chip" Property="Visibility" Value="Visible"/>
          <Setter TargetName="Chip" Property="Background" Value="{StaticResource WarningBg}"/>
          <Setter TargetName="ChipText" Property="Foreground" Value="{StaticResource WarningText}"/>
          <Setter TargetName="ChipIcon" Property="Foreground" Value="{StaticResource WarningText}"/>
          <Setter TargetName="ChipIcon" Property="Text" Value="&#xEA18;"/>
        </DataTrigger>
        <DataTrigger Binding="{Binding StatusKind}" Value="muted">
          <Setter TargetName="Chip" Property="Visibility" Value="Visible"/>
          <Setter TargetName="Chip" Property="Background" Value="{StaticResource MutedBg}"/>
          <Setter TargetName="ChipText" Property="Foreground" Value="{StaticResource TextSecondary}"/>
          <Setter TargetName="ChipIcon" Property="Visibility" Value="Collapsed"/>
        </DataTrigger>
        <DataTrigger Binding="{Binding StatusKind}" Value="success">
          <Setter TargetName="Chip" Property="Visibility" Value="Visible"/>
          <Setter TargetName="Chip" Property="Background" Value="{StaticResource SuccessBg}"/>
          <Setter TargetName="ChipText" Property="Foreground" Value="{StaticResource SuccessText}"/>
          <Setter TargetName="ChipIcon" Property="Foreground" Value="{StaticResource SuccessText}"/>
          <Setter TargetName="ChipIcon" Property="Text" Value="&#xE73E;"/>
        </DataTrigger>
        <DataTrigger Binding="{Binding StatusKind}" Value="info">
          <Setter TargetName="Chip" Property="Visibility" Value="Visible"/>
          <Setter TargetName="Chip" Property="Background" Value="{StaticResource AccentSoft}"/>
          <Setter TargetName="ChipText" Property="Foreground" Value="{StaticResource Accent}"/>
          <Setter TargetName="ChipIcon" Property="Foreground" Value="{StaticResource Accent}"/>
          <Setter TargetName="ChipIcon" Property="Text" Value="&#xE7A7;"/>
        </DataTrigger>
        <DataTrigger Binding="{Binding StatusKind}" Value="error">
          <Setter TargetName="Chip" Property="Visibility" Value="Visible"/>
          <Setter TargetName="Chip" Property="Background" Value="{StaticResource ErrorBg}"/>
          <Setter TargetName="ChipText" Property="Foreground" Value="{StaticResource ErrorText}"/>
          <Setter TargetName="ChipIcon" Property="Foreground" Value="{StaticResource ErrorText}"/>
          <Setter TargetName="ChipIcon" Property="Text" Value="&#xE783;"/>
        </DataTrigger>
      </DataTemplate.Triggers>
    </DataTemplate>

    <DataTemplate x:Key="GroupTemplate">
      <Border BorderBrush="{StaticResource Stroke}" BorderThickness="0,1,0,0" Padding="0,6,0,10">
        <StackPanel>
          <Grid Margin="20,8,12,6">
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="Auto"/>
              <ColumnDefinition Width="*"/>
              <ColumnDefinition Width="Auto"/>
            </Grid.ColumnDefinitions>
            <CheckBox IsChecked="{Binding IsAllSelected, Mode=TwoWay}" IsEnabled="{Binding HasSelectable}"
                      AutomationProperties.Name="{Binding Title, StringFormat='Select all in {0}'}"/>
            <StackPanel Grid.Column="1" Orientation="Horizontal" Margin="12,0,0,0" VerticalAlignment="Center">
              <TextBlock Text="{Binding Title}" Style="{StaticResource BodyStrong}"/>
              <TextBlock Text="{Binding Summary}" Style="{StaticResource Caption}" Margin="12,1,0,0" VerticalAlignment="Center"
                         Typography.NumeralAlignment="Tabular"/>
            </StackPanel>
            <Button Grid.Column="2" Tag="addfolder" Style="{StaticResource LinkButton}" AutomationProperties.Name="Add folder"
                    Visibility="{Binding IsCustom, Converter={StaticResource BoolToVis}}">
              <StackPanel Orientation="Horizontal">
                <TextBlock Text="&#xE710;" Style="{StaticResource Icon}" FontSize="12"/>
                <TextBlock Text="Add folder" Margin="8,0,0,0"/>
              </StackPanel>
            </Button>
          </Grid>
          <TextBlock Style="{StaticResource Caption}" Margin="52,2,20,8" TextWrapping="Wrap"
                     Visibility="{Binding IsEmpty, Converter={StaticResource BoolToVis}}"
                     Text="No custom folders yet. Add one to clean, for example, files in Downloads you have not touched for 30 days."/>
          <ItemsControl ItemsSource="{Binding Rows}" ItemTemplate="{StaticResource RowTemplate}" Focusable="False"/>
        </StackPanel>
      </Border>
    </DataTemplate>
  </Window.Resources>

  <Grid x:Name="Root" Background="{StaticResource Bg}">
    <Grid Margin="24,20,24,12">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <!-- Header -->
      <Grid Grid.Row="0" Margin="0,0,0,18">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Border Width="44" Height="44" CornerRadius="10" Background="{StaticResource Accent}">
          <TextBlock Text="&#xE75C;" Style="{StaticResource Icon}" FontSize="22" Foreground="{StaticResource OnAccent}" HorizontalAlignment="Center"/>
        </Border>
        <StackPanel Grid.Column="1" Margin="14,0,0,0" VerticalAlignment="Center">
          <StackPanel Orientation="Horizontal">
            <TextBlock Text="Disk Cleaner" Style="{StaticResource Subtitle}" FontSize="22"/>
            <TextBlock x:Name="VersionText" Style="{StaticResource Caption}" Margin="8,0,0,3" VerticalAlignment="Bottom"/>
          </StackPanel>
          <TextBlock Text="Find junk files and free up space safely" Style="{StaticResource Caption}" Margin="0,2,0,0"/>
        </StackPanel>
        <StackPanel Grid.Column="2" Orientation="Horizontal" VerticalAlignment="Center">
          <Border x:Name="AdminChip" CornerRadius="13" Padding="10,5" VerticalAlignment="Center">
            <StackPanel Orientation="Horizontal">
              <TextBlock x:Name="AdminIcon" Text="&#xEA18;" Style="{StaticResource Icon}" FontSize="13"/>
              <TextBlock x:Name="AdminText" FontSize="12" Margin="6,0,0,0" VerticalAlignment="Center"/>
            </StackPanel>
          </Border>
          <Button x:Name="ElevateButton" Margin="10,0,0,0" AutomationProperties.Name="Restart as administrator"
                  ToolTip="Include Windows Update, system temp, logs and dumps">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="&#xEA18;" Style="{StaticResource Icon}" FontSize="14"/>
              <TextBlock Text="Restart as administrator" Margin="8,0,0,0"/>
            </StackPanel>
          </Button>
        </StackPanel>
      </Grid>

      <!-- Drives -->
      <WrapPanel x:Name="DrivePanel" Grid.Row="1" Margin="0,0,0,4"/>

      <!-- Result banner -->
      <Border x:Name="InfoBar" Grid.Row="2" CornerRadius="8" Padding="16,10,8,10" Margin="0,12,0,0" BorderThickness="1"
              BorderBrush="{StaticResource Stroke}" Visibility="Collapsed">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBlock x:Name="InfoIcon" Style="{StaticResource Icon}"/>
          <TextBlock x:Name="InfoText" Grid.Column="1" Margin="12,0" TextWrapping="Wrap" VerticalAlignment="Center"/>
          <Button x:Name="InfoClose" Grid.Column="2" Content="&#xE711;" Style="{StaticResource IconButton}" FontSize="12"
                  ToolTip="Dismiss" AutomationProperties.Name="Dismiss message"/>
        </Grid>
      </Border>

      <!-- Body -->
      <Grid Grid.Row="3" Margin="0,16,0,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="16"/>
          <ColumnDefinition Width="330"/>
        </Grid.ColumnDefinitions>

        <Border x:Name="ListCard" Style="{StaticResource Card}" Padding="0">
          <DockPanel>
            <Grid DockPanel.Dock="Top" Margin="20,14,12,10">
              <TextBlock Text="Categories" Style="{StaticResource Subtitle}" FontSize="16" VerticalAlignment="Center"/>
              <StackPanel x:Name="QuickSelect" Orientation="Horizontal" HorizontalAlignment="Right">
                <TextBlock Text="Select" Style="{StaticResource Caption}" VerticalAlignment="Center" Margin="0,0,4,0"/>
                <Button x:Name="SelectRecommended" Content="Recommended" Style="{StaticResource LinkButton}"/>
                <Button x:Name="SelectAll" Content="All" Style="{StaticResource LinkButton}"/>
                <Button x:Name="SelectNone" Content="None" Style="{StaticResource LinkButton}"/>
              </StackPanel>
            </Grid>
            <ScrollViewer VerticalScrollBarVisibility="Auto" Focusable="False">
              <ItemsControl x:Name="GroupList" ItemTemplate="{StaticResource GroupTemplate}" Focusable="False" Margin="0,0,0,8"/>
            </ScrollViewer>
          </DockPanel>
        </Border>

        <ScrollViewer Grid.Column="2" VerticalScrollBarVisibility="Auto" Focusable="False">
          <StackPanel>
            <!-- Summary + primary action -->
            <Border Style="{StaticResource Card}">
              <StackPanel>
                <TextBlock Text="Selected to clean" Style="{StaticResource Caption}"/>
                <TextBlock x:Name="SelectedSize" Text="-" Style="{StaticResource Display}" Margin="0,2,0,0"/>
                <TextBlock x:Name="SelectedInfo" Style="{StaticResource Caption}" TextWrapping="Wrap" Typography.NumeralAlignment="Tabular"/>
                <Grid Margin="0,18,0,0">
                  <StackPanel x:Name="IdleActions">
                    <Button x:Name="CleanButton" Style="{StaticResource AccentButton}" MinHeight="40" AutomationProperties.Name="Clean selected">
                      <StackPanel Orientation="Horizontal">
                        <TextBlock Text="&#xE74D;" Style="{StaticResource Icon}" FontSize="15"/>
                        <TextBlock Text="Clean selected" Margin="10,0,0,0"/>
                      </StackPanel>
                    </Button>
                    <Button x:Name="ScanButton" Margin="0,8,0,0" AutomationProperties.Name="Rescan" ToolTip="Rescan (F5)">
                      <StackPanel Orientation="Horizontal">
                        <TextBlock Text="&#xE72C;" Style="{StaticResource Icon}" FontSize="14"/>
                        <TextBlock Text="Rescan" Margin="10,0,0,0"/>
                      </StackPanel>
                    </Button>
                  </StackPanel>
                  <StackPanel x:Name="BusyActions" Visibility="Collapsed">
                    <TextBlock x:Name="PhaseText" Style="{StaticResource BodyStrong}"/>
                    <TextBlock x:Name="ProgressText" Style="{StaticResource Caption}" Margin="0,2,0,0" Typography.NumeralAlignment="Tabular"/>
                    <ProgressBar x:Name="Progress" Margin="0,12,0,14"/>
                    <Button x:Name="CancelButton" Content="Cancel" MinHeight="40" AutomationProperties.Name="Cancel current task"/>
                  </StackPanel>
                </Grid>
              </StackPanel>
            </Border>

            <!-- Options -->
            <Border x:Name="OptionsCard" Style="{StaticResource Card}" Margin="0,16,0,0">
              <StackPanel>
                <TextBlock Text="Options" Style="{StaticResource Subtitle}" FontSize="16" Margin="0,0,0,14"/>
                <DockPanel>
                  <TextBlock x:Name="AgeText" DockPanel.Dock="Right" Style="{StaticResource BodyStrong}" Typography.NumeralAlignment="Tabular"/>
                  <TextBlock x:Name="AgeLabel" Text="Only files older than" Style="{StaticResource Body}"/>
                </DockPanel>
                <Slider x:Name="AgeSlider" Minimum="0" Maximum="30" TickFrequency="1" IsSnapToTickEnabled="True" Margin="0,8,0,4"
                        SmallChange="1" LargeChange="7" AutomationProperties.Name="Only delete files older than, in days"/>
                <TextBlock Text="Newer files may still be in use by running apps." Style="{StaticResource Caption}" TextWrapping="Wrap"/>

                <TextBlock Text="Drive type" Style="{StaticResource Body}" Margin="0,18,0,8"/>
                <Border Background="{StaticResource SegmentTrack}" CornerRadius="7" Padding="2">
                  <UniformGrid Columns="2">
                    <RadioButton x:Name="DiskSsd" GroupName="Disk" Content="SSD" Style="{StaticResource Segment}" AutomationProperties.Name="Drive type SSD"/>
                    <RadioButton x:Name="DiskHdd" GroupName="Disk" Content="Hard disk (HDD)" Style="{StaticResource Segment}" AutomationProperties.Name="Drive type hard disk"/>
                  </UniformGrid>
                </Border>
                <TextBlock x:Name="DiskHint" Style="{StaticResource Caption}" TextWrapping="Wrap" Margin="0,6,0,0"/>

                <CheckBox x:Name="RecycleCustom" Margin="0,18,0,0" AutomationProperties.Name="Move files from custom folders to the Recycle Bin">
                  <TextBlock Text="Custom folders: move files to the Recycle Bin" TextWrapping="Wrap"/>
                </CheckBox>
                <TextBlock Style="{StaticResource Caption}" TextWrapping="Wrap" Margin="28,4,0,0"
                           Text="Safer for personal files: you can restore them. The space is freed when you empty the Recycle Bin."/>
              </StackPanel>
            </Border>

            <!-- Big items that need a human decision -->
            <Border Style="{StaticResource Card}" Margin="0,16,0,0">
              <StackPanel>
                <TextBlock Text="Needs your decision" Style="{StaticResource Subtitle}" FontSize="16"/>
                <TextBlock Text="Large items this app will not remove for you." Style="{StaticResource Caption}" Margin="0,2,0,12"/>
                <StackPanel x:Name="HintPanel"/>
              </StackPanel>
            </Border>
          </StackPanel>
        </ScrollViewer>
      </Grid>

      <!-- Log -->
      <Border x:Name="LogPanel" Grid.Row="4" Style="{StaticResource Card}" Padding="12,8" Margin="0,12,0,0" Visibility="Collapsed">
        <TextBox x:Name="LogBox" Height="130" IsReadOnly="True" FontFamily="Cascadia Mono, Consolas" FontSize="12"
                 Background="Transparent" BorderThickness="0" Foreground="{StaticResource TextSecondary}"
                 VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Auto" AutomationProperties.Name="Activity log"/>
      </Border>

      <!-- Status bar -->
      <Grid Grid.Row="5" Margin="0,8,0,0">
        <TextBlock x:Name="StatusText" Style="{StaticResource Caption}" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"
                   Margin="0,0,120,0" Typography.NumeralAlignment="Tabular"/>
        <Button x:Name="LogButton" Style="{StaticResource SubtleButton}" HorizontalAlignment="Right" MinHeight="30" AutomationProperties.Name="Show log">
          <StackPanel Orientation="Horizontal">
            <TextBlock x:Name="LogButtonText" Text="Show log" FontSize="12" Foreground="{StaticResource TextSecondary}"/>
            <TextBlock x:Name="LogChevron" Text="&#xE70E;" Style="{StaticResource Icon}" FontSize="10" Margin="8,0,0,0" Foreground="{StaticResource TextSecondary}"/>
          </StackPanel>
        </Button>
      </Grid>
    </Grid>

    <!-- Confirmation dialog -->
    <Grid x:Name="Overlay" Background="{StaticResource Scrim}" Visibility="Collapsed">
      <Border x:Name="DialogCard" Width="480" Background="{StaticResource Surface}" CornerRadius="8" BorderBrush="{StaticResource Stroke}"
              BorderThickness="1" HorizontalAlignment="Center" VerticalAlignment="Center" RenderTransformOrigin="0.5,0.5"
              KeyboardNavigation.TabNavigation="Cycle" AutomationProperties.Name="Confirm cleaning">
        <Border.RenderTransform><ScaleTransform x:Name="DialogScale"/></Border.RenderTransform>
        <Border.Effect><DropShadowEffect BlurRadius="40" ShadowDepth="10" Direction="270" Opacity="0.28"/></Border.Effect>
        <StackPanel>
          <StackPanel Margin="24,22,24,20">
            <TextBlock x:Name="DialogTitle" Style="{StaticResource Subtitle}" TextWrapping="Wrap"/>
            <TextBlock x:Name="DialogBody" Style="{StaticResource Body}" Foreground="{StaticResource TextSecondary}" Margin="0,8,0,0" TextWrapping="Wrap"/>
            <Border Background="{StaticResource SurfaceAlt}" BorderBrush="{StaticResource Stroke}" BorderThickness="1" CornerRadius="6"
                    Padding="12,8" Margin="0,12,0,0" MaxHeight="170">
              <ScrollViewer VerticalScrollBarVisibility="Auto" Focusable="False">
                <ItemsControl x:Name="DialogList" Focusable="False">
                  <ItemsControl.ItemTemplate>
                    <DataTemplate>
                      <Grid Margin="0,3">
                        <TextBlock Text="{Binding Name}" Style="{StaticResource Body}"/>
                        <TextBlock Text="{Binding SizeText}" Style="{StaticResource BodyStrong}" HorizontalAlignment="Right" Typography.NumeralAlignment="Tabular"/>
                      </Grid>
                    </DataTemplate>
                  </ItemsControl.ItemTemplate>
                </ItemsControl>
              </ScrollViewer>
            </Border>
            <Grid Margin="0,14,0,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
              </Grid.ColumnDefinitions>
              <TextBlock Text="&#xE7BA;" Style="{StaticResource Icon}" FontSize="14" Foreground="{StaticResource WarningText}" VerticalAlignment="Top" Margin="0,1,10,0"/>
              <TextBlock x:Name="DialogNote" Grid.Column="1" Style="{StaticResource Caption}" TextWrapping="Wrap"/>
            </Grid>
          </StackPanel>
          <Border Background="{StaticResource SurfaceAlt}" BorderBrush="{StaticResource Stroke}" BorderThickness="0,1,0,0"
                  CornerRadius="0,0,8,8" Padding="24,16">
            <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
              <Button x:Name="DialogCancel" Content="Cancel" MinWidth="110"/>
              <Button x:Name="DialogConfirm" Style="{StaticResource DangerButton}" MinWidth="130" Margin="8,0,0,0">
                <TextBlock x:Name="DialogConfirmText" Text="Delete"/>
              </Button>
            </StackPanel>
          </Border>
        </StackPanel>
      </Border>
    </Grid>
  </Grid>
</Window>
'@

$brushes = ($Palettes[$ThemeName].GetEnumerator() | ForEach-Object { "<SolidColorBrush x:Key=`"$($_.Key)`" Color=`"$($_.Value)`"/>" }) -join "`n    "
$xamlText = $xamlText.Replace('<!--BRUSHES-->', $brushes)
$window = [Windows.Markup.XamlReader]::Parse($xamlText)
$ui = @{}
foreach ($m in [regex]::Matches($xamlText, 'x:Name="(\w+)"')) {
    $element = $window.FindName($m.Groups[1].Value)
    if ($element) { $ui[$m.Groups[1].Value] = $element }
}
$ui.VersionText.Text = "v$DiskCleanerVersion"
function Get-Brush([string]$Key) { $window.FindResource($Key) }
#endregion

#region State -------------------------------------------------------------------
$isAdmin = Test-IsAdmin
$SelfPath = $PSCommandPath
$SettingsFile = Join-Path $env:LOCALAPPDATA 'DiskCleaner\settings.json'
$FastThreads = [Math]::Min([Environment]::ProcessorCount, 8)
$Dot = [string][char]0x00B7

$GroupTitles = [ordered]@{ Core = 'Recommended'; AI = 'AI apps'; Dev = 'Developer caches'; Deep = 'Deep clean'; Custom = 'Custom folders' }
# Segoe Fluent Icons / MDL2 code points
$CategoryIcons = @{
    UserTemp = 0xE81C; WindowsTemp = 0xE770; BrowserCache = 0xE774; AppCache = 0xE71D; ShaderCache = 0xE7FC
    ThumbCache = 0xEB9F; CrashDumps = 0xEBE8; SystemDumps = 0xEBE8; WindowsUpdate = 0xE895; DeliveryOpt = 0xE753
    WindowsLogs = 0xE8A5; ClaudeCache = 0xE99A; ChatGPTCache = 0xE8BD; AIEditorCache = 0xE943; CopilotCache = 0xE99A
    OtherAppCache = 0xE71D; npm = 0xE7B8; Yarn = 0xE7B8; pip = 0xE7B8; NuGet = 0xE7B8; Gradle = 0xE943
    GoBuild = 0xE943; Cargo = 0xE7B8; RecycleBin = 0xE74D; ComponentStore = 0xE90F
    UpgradeTemp = 0xE896; WindowsOld = 0xE777
}

$groups = [System.Collections.ObjectModel.ObservableCollection[DiskCleaner.CategoryGroup]]::new()
$groupByKey = @{}
foreach ($key in $GroupTitles.Keys) {
    $g = [DiskCleaner.CategoryGroup]::new()
    $g.Key = $key
    $g.Title = $GroupTitles[$key]
    $groups.Add($g)
    $groupByKey[$key] = $g
}
$catByName = @{}
$script:Job = $null
$script:PendingScan = $null
$script:PendingClean = $null
$script:SavedSelection = @()
$script:AfterFirstScan = $null
#endregion

#region Functions ---------------------------------------------------------------
function Write-Log([string]$Message) {
    $ui.LogBox.AppendText(('[{0:HH:mm:ss}] {1}' -f (Get-Date), $Message) + [Environment]::NewLine)
    $ui.LogBox.ScrollToEnd()
}

function Get-AllRows { foreach ($g in $groups) { foreach ($r in $g.Rows) { $r } } }

function Get-RowByName([string]$Name) {
    foreach ($r in Get-AllRows) { if ($r.Name -eq $Name) { return $r } }
}

function Get-Threads { if ($ui.DiskHdd.IsChecked) { 2 } else { $FastThreads } }

function Set-RowStatus($Row, [string]$Status) {
    $kind, $text = switch -Regex ($Status) {
        '^$'                { '', ''; break }
        '^needs admin$'     { 'warn', 'Needs admin'; break }
        '^restart pending$' { 'warn', 'Restart first'; break }
        '^not found$'       { 'muted', 'Not found'; break }
        '^size n/a$'        { 'muted', 'Size unknown'; break }
        '^(freed|done|moved)' { 'success', ($Status.Substring(0, 1).ToUpper() + $Status.Substring(1)); break }
        '^to Recycle Bin'   { 'info', ('T' + $Status.Substring(1)); break }
        '^(failed|not run)' { 'error', 'Failed - see log'; break }
        default             { 'muted', $Status }
    }
    $Row.StatusKind = $kind
    $Row.Status = $text
}

function Add-Row($Category, [bool]$Selected) {
    $row = [DiskCleaner.CategoryRow]::new()
    $row.Name = $Category.Name
    $row.Group = $Category.Group
    $row.Description = $Category.Description
    $code = if ($CategoryIcons.ContainsKey($Category.Name)) { $CategoryIcons[$Category.Name] } else { 0xE8B7 }
    $row.Icon = [string][char]$code
    $row.CanOpen = $Category.Paths.Count -gt 0
    $row.IsAvailable = -not ($Category.Admin -and -not $isAdmin)
    $row.IsSelected = $Selected -and $row.IsAvailable
    if (-not $row.IsAvailable) { Set-RowStatus $row 'needs admin' }
    $row.add_PropertyChanged({ param($s, $e) if ($e.PropertyName -eq 'IsSelected') { Update-Summary } })
    $catByName[$row.Name] = $Category
    $groupByKey[$Category.Group].Rows.Add($row)
    $row
}

function New-CustomCategory([string]$Path) {
    # Split-Path -Leaf of a drive root ("D:\") returns "", so name it after the drive instead.
    $leaf = Split-Path $Path -Leaf
    $isDrive = $Path -match '^[A-Za-z]:\\?$'
    $base = if ($isDrive) { "$($Path.Substring(0, 2))\ (whole drive)" } else { $leaf }
    $name = $base
    for ($i = 2; $catByName.ContainsKey($name); $i++) { $name = "$base ($i)" }
    $description = if ($isDrive) { "Temp and junk files anywhere on $($Path.Substring(0, 2))\" } else { $Path }
    New-Category $name Custom @($Path) $description -Recycle ([bool]$ui.RecycleCustom.IsChecked)
}

function Read-Settings {
    try { if (Test-Path $SettingsFile) { return Get-Content $SettingsFile -Raw | ConvertFrom-Json } } catch { }
    $null
}

function Save-Settings {
    if ($SnapshotPath) { return } # automated checks must not touch the user's settings
    $all = @(Get-AllRows)
    $selected = @($all | Where-Object { $_.IsSelected } | ForEach-Object { $_.Name })
    # Keep choices for categories unavailable in this session (admin-only when not elevated).
    $unavailable = @($all | Where-Object { -not $_.IsAvailable } | ForEach-Object { $_.Name })
    $selected += @($script:SavedSelection | Where-Object { $_ -in $unavailable })
    $data = [ordered]@{
        Selected      = @($selected | Select-Object -Unique)
        MinAgeDays    = [int]$ui.AgeSlider.Value
        DiskType      = if ($ui.DiskHdd.IsChecked) { 'HDD' } else { 'SSD' }
        CustomToRecycleBin = [bool]$ui.RecycleCustom.IsChecked
        CustomFolders = @($groupByKey.Custom.Rows | ForEach-Object { $catByName[$_.Name].Paths[0] })
    }
    try {
        [void][IO.Directory]::CreateDirectory((Split-Path $SettingsFile))
        $data | ConvertTo-Json | Set-Content -Path $SettingsFile -Encoding UTF8
    } catch { Write-Log "Could not save settings: $($_.Exception.Message)" }
}

function Update-Summary {
    $all = @(Get-AllRows | Where-Object { $_.IsAvailable })
    $sel = @($all | Where-Object { $_.IsSelected })
    $selBytes = [long](($sel | Where-Object { $_.Bytes -gt 0 } | Measure-Object -Property Bytes -Sum).Sum)
    $foundBytes = [long](($all | Where-Object { $_.Bytes -gt 0 } | Measure-Object -Property Bytes -Sum).Sum)
    $ui.SelectedSize.Text = Format-Size $selBytes
    $ui.SelectedInfo.Text = '{0} of {1} categories  {2}  {3} found' -f $sel.Count, $all.Count, $Dot, (Format-Size $foundBytes)
    $ui.CleanButton.IsEnabled = ($sel.Count -gt 0) -and -not $script:Job
}

function Update-SizeBars {
    $max = [double](@(Get-AllRows | ForEach-Object { $_.Bytes }) + 1 | Measure-Object -Maximum).Maximum
    foreach ($r in Get-AllRows) { $r.SizeRatio = if ($r.Bytes -gt 0) { $r.Bytes / $max } else { 0 } }
}

function Update-AgeText {
    $days = [int]$ui.AgeSlider.Value
    $ui.AgeText.Text = switch ($days) { 0 { 'Any age' } 1 { '1 day' } default { "$days days" } }
}

function Update-DiskHint {
    $ui.DiskHint.Text = if ($ui.DiskHdd.IsChecked) { 'Uses 2 threads so a spinning disk is not overloaded.' }
                        else { "Uses $FastThreads threads in parallel." }
}

function New-TextBlock([string]$Text, [string]$Style) {
    $tb = [Windows.Controls.TextBlock]::new()
    $tb.Text = $Text
    if ($Style) { $tb.Style = $window.FindResource($Style) }
    $tb
}

function Update-Drives {
    $ui.DrivePanel.Children.Clear()
    $systemDrive = $env:SystemDrive.TrimEnd('\')
    foreach ($d in [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }) {
        $usedPct = 100 * (1 - $d.TotalFreeSpace / $d.TotalSize)
        $label = try { $d.VolumeLabel } catch { '' }
        $driveRoot = $d.Name.TrimEnd('\')
        $card = [Windows.Controls.Border]::new()
        $card.Style = $window.FindResource('Card')
        $card.Padding = '14,12'
        $card.Margin = '0,0,12,12'
        $card.Width = 250

        $grid = [Windows.Controls.Grid]::new()
        foreach ($w in 'Auto', '*', 'Auto') {
            $col = [Windows.Controls.ColumnDefinition]::new()
            $col.Width = [Windows.GridLengthConverter]::new().ConvertFromString($w)
            $grid.ColumnDefinitions.Add($col)
        }
        $icon = New-TextBlock ([string][char]0xEDA2) 'Icon'
        $icon.FontSize = 22
        $icon.Margin = '0,0,12,0'
        $icon.Foreground = Get-Brush 'TextSecondary'
        $grid.Children.Add($icon) | Out-Null

        $stack = [Windows.Controls.StackPanel]::new()
        [Windows.Controls.Grid]::SetColumn($stack, 1)
        $title = New-TextBlock ($(if ($label) { "$label ($driveRoot)" } else { "Local disk ($driveRoot)" })) 'BodyStrong'
        $title.TextTrimming = 'CharacterEllipsis'
        $bar = [Windows.Controls.ProgressBar]::new()
        $bar.Maximum = 100
        $bar.Value = $usedPct
        $bar.Margin = '0,6,0,6'
        $bar.IsTabStop = $false
        $almostFull = $usedPct -ge 90
        if ($almostFull) { $bar.Foreground = Get-Brush 'Danger' }
        $free = '{0} free of {1}' -f (Format-Size $d.TotalFreeSpace), (Format-Size $d.TotalSize)
        if ($almostFull) { $free += "  $Dot  Almost full" }
        $caption = New-TextBlock $free 'Caption'
        [Windows.Automation.AutomationProperties]::SetName($bar, "$($d.Name) used $([int]$usedPct) percent")
        foreach ($child in $title, $bar, $caption) { $stack.Children.Add($child) | Out-Null }
        $grid.Children.Add($stack) | Out-Null

        # The system drive's junk is already covered by every other category; only other drives get the shortcut.
        if ($driveRoot -ne $systemDrive -and -not ($groupByKey.Custom.Rows | Where-Object { $catByName[$_.Name].Paths[0] -match "^$([regex]::Escape($driveRoot))\\?$" })) {
            $addButton = [Windows.Controls.Button]::new()
            $addButton.Style = $window.FindResource('IconButton')
            $addButton.Content = [string][char]0xE710
            $addButton.ToolTip = "Add $driveRoot\ to the cleaning list"
            $addButton.VerticalAlignment = 'Top'
            [Windows.Automation.AutomationProperties]::SetName($addButton, "Add drive $driveRoot to the cleaning list")
            $addButton.Tag = $driveRoot
            $addButton.add_Click({ param($s, $e) Add-DriveFolder $s.Tag })
            [Windows.Controls.Grid]::SetColumn($addButton, 2)
            $grid.Children.Add($addButton) | Out-Null
        }

        $card.Child = $grid
        $ui.DrivePanel.Children.Add($card) | Out-Null
    }
}

function Update-Hints {
    $ui.HintPanel.Children.Clear()
    $hints = @(Get-SpaceHint)
    if (-not $hints) { $hints = @('Nothing large found.') }
    foreach ($h in $hints) {
        $grid = [Windows.Controls.Grid]::new()
        $grid.Margin = '0,0,0,10'
        foreach ($w in 'Auto', '*') {
            $col = [Windows.Controls.ColumnDefinition]::new()
            $col.Width = [Windows.GridLengthConverter]::new().ConvertFromString($w)
            $grid.ColumnDefinitions.Add($col)
        }
        $icon = New-TextBlock ([string][char]0xE946) 'Icon'
        $icon.FontSize = 13
        $icon.VerticalAlignment = 'Top'
        $icon.Margin = '0,2,10,0'
        $icon.Foreground = Get-Brush 'Accent'
        $text = New-TextBlock $h 'Caption'
        $text.TextWrapping = 'Wrap'
        $text.Foreground = Get-Brush 'Text'
        [Windows.Controls.Grid]::SetColumn($text, 1)
        $grid.Children.Add($icon) | Out-Null
        $grid.Children.Add($text) | Out-Null
        $ui.HintPanel.Children.Add($grid) | Out-Null
    }
}

function Show-InfoBar([string]$Kind, [string]$Text) {
    $bg, $fg, $glyph = switch ($Kind) {
        'success' { 'SuccessBg', 'SuccessText', 0xE930 }
        'error'   { 'ErrorBg', 'ErrorText', 0xE783 }
        default   { 'AccentSoft', 'Accent', 0xE946 }
    }
    $ui.InfoBar.Background = Get-Brush $bg
    $ui.InfoIcon.Foreground = Get-Brush $fg
    $ui.InfoIcon.Text = [string][char]$glyph
    $ui.InfoText.Text = $Text
    $ui.InfoBar.Visibility = 'Visible'
}

function Set-Busy([bool]$Busy, [bool]$LockList) {
    $ui.IdleActions.Visibility = if ($Busy) { 'Collapsed' } else { 'Visible' }
    $ui.BusyActions.Visibility = if ($Busy) { 'Visible' } else { 'Collapsed' }
    $ui.Progress.IsIndeterminate = $Busy -and $Animate
    $ui.Progress.Visibility = if ($Animate) { 'Visible' } else { 'Collapsed' }
    $ui.CancelButton.IsEnabled = $Busy
    foreach ($name in 'OptionsCard', 'QuickSelect', 'ElevateButton') { $ui[$name].IsEnabled = -not $Busy }
    $ui.ListCard.IsEnabled = -not ($Busy -and $LockList)
    Update-Summary
}

function Start-UiJob([hashtable]$Job) {
    $script:Job = $Job
    $ui.PhaseText.Text = $Job.Sync.Phase
    $ui.ProgressText.Text = 'Starting...'
    Set-Busy $true ($Job.Kind -eq 'Clean')
    $timer.Start()
}

function Start-Scan([DiskCleaner.CategoryRow[]]$Only) {
    if ($script:Job) { $script:PendingScan = if ($Only) { $Only } else { 'all' }; return }
    $scanRows = if ($Only) { $Only } else { @(Get-AllRows) }
    $cats = @($scanRows | ForEach-Object { $catByName[$_.Name] })
    $cutoff = [DateTime]::UtcNow.AddDays(-[int]$ui.AgeSlider.Value)
    $targets = New-TargetList -Categories $cats -IsAdmin $isAdmin -CutoffUtc $cutoff
    Start-UiJob @{
        Kind    = 'Scan'
        Task    = [DiskCleaner.Engine]::Start($targets.ToArray(), (Get-Threads), $false)
        Sync    = @{ Phase = 'Scanning' }
        Rows    = $scanRows
        Cats    = $cats
        Targets = $targets
        Clock   = [Diagnostics.Stopwatch]::StartNew()
        OnDone  = { param($job) Complete-Scan $job }
    }
}

function Complete-Scan($Job) {
    if ($Job.Task.IsFaulted) {
        Write-Log "Scan failed: $($Job.Task.Exception.InnerException.Message)"
        Show-InfoBar 'error' 'The scan failed. Open the log for details, then press Rescan.'
        return
    }
    foreach ($r in @(Get-Report -Selected $Job.Cats -Targets $Job.Targets)) {
        $row = Get-RowByName $r.Category
        if (-not $row) { continue } # removed while scanning
        # These statuses mean there are no meaningful numbers.
        $noData = $r.Status -in 'needs admin', 'restart pending', 'not found', 'size n/a'
        $row.Files = if ($noData) { -1 } else { $r.Files }
        $row.Bytes = if ($noData) { -1 } else { $r.Bytes }
        Set-RowStatus $row $r.Status
    }
    Update-SizeBars
    $msg = 'Scan finished in {0:N1}s  {1}  {2:N0} files checked' -f $Job.Clock.Elapsed.TotalSeconds, $Dot, [DiskCleaner.Engine]::Processed
    $ui.StatusText.Text = $msg
    Write-Log $msg

    if ($script:AfterFirstScan) {
        $action = $script:AfterFirstScan
        $script:AfterFirstScan = $null
        [void]$window.Dispatcher.BeginInvoke([Windows.Threading.DispatcherPriority]::ContextIdle, [Action]$action)
    }
}

function Show-Confirm {
    if ($script:Job) { return }
    $sel = @(Get-AllRows | Where-Object { $_.IsSelected -and $_.IsAvailable })
    if (-not $sel) { return }
    $bytes = [long](($sel | Where-Object { $_.Bytes -gt 0 } | Measure-Object -Property Bytes -Sum).Sum)
    $recycling = @($sel | Where-Object { $catByName[$_.Name].Recycle })
    $script:PendingClean = $sel
    $size = Format-Size $bytes
    $ui.DialogBody.Text = if ($sel.Count -eq 1) { 'This category will be cleaned:' } else { "These $($sel.Count) categories will be cleaned:" }
    $ui.DialogList.ItemsSource = $sel
    if ($recycling.Count -eq $sel.Count) {
        # Everything is restorable: a normal (non-danger) confirmation.
        $ui.DialogTitle.Text = "Move $size to the Recycle Bin?"
        $ui.DialogConfirmText.Text = "Move $size"
        $ui.DialogConfirm.Style = $window.FindResource('AccentButton')
        $ui.DialogNote.Text = 'You can restore these files from the Recycle Bin. Files that are too large for it, or have very long paths, are left in place. Files in use are skipped.'
    } else {
        $ui.DialogTitle.Text = if ($recycling) { "Clean $size?" } else { "Delete $size of junk files?" }
        $ui.DialogConfirmText.Text = if ($recycling) { "Clean $size" } else { "Delete $size" }
        $ui.DialogConfirm.Style = $window.FindResource('DangerButton')
        $ui.DialogNote.Text = if ($recycling) {
            'Files from your custom folders go to the Recycle Bin. Everything else is deleted permanently. Files in use are skipped.'
        } else { 'Files are deleted permanently (they do not go to the Recycle Bin). Files that are in use are skipped.' }
    }
    [Windows.Automation.AutomationProperties]::SetName($ui.DialogConfirm, $ui.DialogConfirmText.Text)
    $ui.Overlay.Visibility = 'Visible'
    if ($Animate) {
        $ease = [Windows.Media.Animation.CubicEase]::new()
        $ease.EasingMode = 'EaseOut'
        $fade = [Windows.Media.Animation.DoubleAnimation]::new(0, 1, [Windows.Duration]::new([TimeSpan]::FromMilliseconds(150)))
        $grow = [Windows.Media.Animation.DoubleAnimation]::new(0.96, 1, [Windows.Duration]::new([TimeSpan]::FromMilliseconds(200)))
        $grow.EasingFunction = $ease
        $ui.Overlay.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
        $ui.DialogScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $grow)
        $ui.DialogScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $grow)
    }
    [void]$ui.DialogCancel.Focus() # the safe choice has focus
}

function Hide-Confirm {
    $ui.Overlay.Visibility = 'Collapsed'
    [void]$ui.CleanButton.Focus()
}

function Start-Clean {
    $sel = $script:PendingClean
    Hide-Confirm
    if (-not $sel) { return }
    Save-Settings
    $ui.InfoBar.Visibility = 'Collapsed'
    $cats = @($sel | ForEach-Object { $catByName[$_.Name] })
    $cutoff = [DateTime]::UtcNow.AddDays(-[int]$ui.AgeSlider.Value)
    $targets = New-TargetList -Categories $cats -IsAdmin $isAdmin -CutoffUtc $cutoff
    $cmdNames = @($cats | Where-Object { $_.CleanCmd } | ForEach-Object { $_.Name })
    $fileTargets = [DiskCleaner.Target[]]@($targets | Where-Object { $_.Category -notin $cmdNames })
    $bg = Start-BackgroundClean -Targets $fileTargets -Categories $cats -Threads (Get-Threads)

    Write-Log "Cleaning: $(($sel | ForEach-Object { $_.Name }) -join ', ')"
    Start-UiJob @{
        Kind       = 'Clean'
        Handle     = $bg.Handle
        PS         = $bg.PS
        Sync       = $bg.Sync
        Rows       = $sel
        Targets    = $fileTargets
        FreeBefore = Get-FreeBytes
        Clock      = [Diagnostics.Stopwatch]::StartNew()
        OnDone     = { param($job) Complete-Clean $job }
    }
}

function Complete-Clean($Job) {
    $cmdStatus = @{}
    $errors = 0
    try {
        $out = $Job.PS.EndInvoke($Job.Handle)
        if ($out.Count) { $cmdStatus = [hashtable]$out[$out.Count - 1] }
    } catch {
        $errors++
        Write-Log "Clean failed: $($_.Exception.InnerException.Message)"
    }
    foreach ($err in $Job.PS.Streams.Error) { $errors++; Write-Log "Error: $err" }
    $Job.PS.Dispose()

    $skippedTotal = 0
    $recycledTotal = 0
    $keptTotal = 0
    foreach ($row in $Job.Rows) {
        $cat = $catByName[$row.Name]
        if ($cat.CleanCmd -and $cat.Skip) {
            # Nothing there, or blocked (restart pending): not an error.
            $status = if ($cat.Status) { $cat.Status } else { 'not found' }
            Set-RowStatus $row $status
            Write-Log "$($row.Name): skipped ($status)"
            continue
        }
        if ($cat.CleanCmd) {
            $status = if ($cmdStatus[$row.Name]) { $cmdStatus[$row.Name] } else { 'not run' }
            if ($status -ne 'done') { $errors++ }
            Set-RowStatus $row $status
            if ($status -eq 'done') { $row.Files = 0; $row.Bytes = 0 }
            Write-Log "$($row.Name): $status"
            continue
        }
        $ts = @($Job.Targets | Where-Object { $_.Category -eq $row.Name })
        $files = [long](($ts | Measure-Object -Property Files -Sum).Sum)
        $freed = [long](($ts | Measure-Object -Property Bytes -Sum).Sum)
        $skipped = [long](($ts | Measure-Object -Property Skipped -Sum).Sum)
        $kept = [long](($ts | Measure-Object -Property NotRecycled -Sum).Sum)
        $recycled = $catByName[$row.Name].Recycle
        $skippedTotal += $skipped
        $keptTotal += $kept
        if ($recycled) { $recycledTotal += $freed }
        $row.Files = [Math]::Max([long]0, $row.Files - $files)
        $row.Bytes = [Math]::Max([long]0, $row.Bytes - $freed)
        $status = if ($recycled) { "moved $(Format-Size $freed) to Recycle Bin" } else { "freed $(Format-Size $freed)" }
        if ($skipped) { $status += "  $Dot  {0:N0} in use" -f $skipped }
        if ($kept) { $status += "  $Dot  {0:N0} kept" -f $kept }
        Set-RowStatus $row $status
        Write-Log ('{0}: {1} {2:N0} files, {3}, in use {4:N0}, kept (too large / long path) {5:N0}' -f $row.Name,
            $(if ($recycled) { 'recycled' } else { 'deleted' }), $files, (Format-Size $freed), $skipped, $kept)
    }

    # Recycling frees nothing until the bin is emptied, and other apps keep writing: never show a negative gain.
    $gained = [Math]::Max([long]0, (Get-FreeBytes) - $Job.FreeBefore)
    $msg = 'Cleaned in {0:N1}s  {1}  free space gained {2}' -f $Job.Clock.Elapsed.TotalSeconds, $Dot, (Format-Size $gained)
    $ui.StatusText.Text = $msg
    Write-Log $msg
    if ($errors) {
        Show-InfoBar 'error' "Freed $(Format-Size $gained), but some steps failed. Open the log for details."
    } else {
        $note = switch ($skippedTotal) {
            0       { '' }
            1       { ' 1 file was in use and was skipped; close the app using it and clean again to remove it.' }
            default { ' {0:N0} files were in use and were skipped; close those apps and clean again to remove them.' -f $skippedTotal }
        }
        if ($recycledTotal) {
            $note = " Moved $(Format-Size $recycledTotal) to the Recycle Bin; restore from there if needed, or empty it to free that space." + $note
        }
        if ($keptTotal) {
            $note += ' {0:N0} files from custom folders were left in place because the Recycle Bin cannot take them (too large or path too long).' -f $keptTotal
        }
        $freed = if ($gained -gt 0) { " Freed $(Format-Size $gained) of disk space." } else { '' }
        if (-not ($freed + $note)) { $note = ' Nothing needed cleaning.' }
        Show-InfoBar 'success' "Done.$freed$note"
    }
    Update-SizeBars
    Update-Drives
}

function Open-RowFolder($Row) {
    $path = @(Resolve-CategoryPath $catByName[$Row.Name]) | Select-Object -First 1
    if (-not $path) { $ui.StatusText.Text = "No folder found for $($Row.Name)."; return }
    if ([IO.File]::Exists($path)) { Start-Process explorer.exe "/select,`"$path`"" }
    else { Start-Process explorer.exe "`"$path`"" }
}

function Add-CustomFolder {
    $dialog = [Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = 'Choose a folder. Only temp and junk files in it (older than the age filter) will be cleaned; your own files are never touched.'
    if ($dialog.ShowDialog() -ne 'OK') { return }
    $path = $dialog.SelectedPath.TrimEnd('\')
    if (-not (Test-CustomRoot $path)) {
        Show-InfoBar 'error' "$path is a system or profile folder and cannot be cleaned. Choose a folder inside it instead."
        return
    }
    if ($groupByKey.Custom.Rows | Where-Object { $catByName[$_.Name].Paths[0] -eq $path }) {
        $ui.StatusText.Text = 'That folder is already in the list.'
        return
    }
    $row = Add-Row (New-CustomCategory $path) $true
    Save-Settings
    Start-Scan @($row)
}

function Add-DriveFolder([string]$DriveRoot) {
    $path = "$DriveRoot\"
    if (-not (Test-CustomRoot $path)) {
        Show-InfoBar 'error' "$DriveRoot\ cannot be cleaned (Windows is installed on it)."
        return
    }
    if ($groupByKey.Custom.Rows | Where-Object { $catByName[$_.Name].Paths[0] -eq $path }) {
        $ui.StatusText.Text = "$DriveRoot\ is already in the list."
        return
    }
    $question = "Add $DriveRoot\ to the cleaning list?`n`n" +
        'This searches the whole drive for temp and junk files only: Temp folders, *.tmp files, ' +
        'crash dumps, thumbnail and shader caches, abandoned partial downloads and similar. Your own ' +
        'files are never touched. Nothing is cleaned until you press Clean selected.'
    # Default result "No": Enter alone (or a stray click that just dismisses it) must never add a
    # whole drive by accident.
    if ([Windows.MessageBox]::Show($window, $question, 'Disk Cleaner', 'YesNo', 'Warning', 'No') -ne 'Yes') { return }
    $row = Add-Row (New-CustomCategory $path) $true
    Save-Settings
    Update-Drives # removes this drive's "Add" button now that it is in the list
    Start-Scan @($row)
}

function Remove-CustomRow($Row) {
    [void]$groupByKey.Custom.Rows.Remove($Row)
    $catByName.Remove($Row.Name)
    Save-Settings
    Update-SizeBars
    Update-Summary
    Update-Drives # brings back that drive's "Add" button, if this was a whole-drive entry
    $ui.StatusText.Text = "Removed $($Row.Name) from the list. No files were deleted."
}

function Set-Selection([scriptblock]$Rule) {
    foreach ($row in Get-AllRows) { if ($row.IsAvailable) { $row.IsSelected = [bool](& $Rule $row) } }
    Save-Settings
}

function Set-LogVisible([bool]$Visible) {
    $ui.LogPanel.Visibility = if ($Visible) { 'Visible' } else { 'Collapsed' }
    $ui.LogButtonText.Text = if ($Visible) { 'Hide log' } else { 'Show log' }
    $ui.LogChevron.Text = [string][char]$(if ($Visible) { 0xE70D } else { 0xE70E })
    [Windows.Automation.AutomationProperties]::SetName($ui.LogButton, $ui.LogButtonText.Text)
}

function New-AppIcon {
    $visual = [Windows.Media.DrawingVisual]::new()
    $dc = $visual.RenderOpen()
    $dc.DrawRoundedRectangle((Get-Brush 'Accent'), $null, [Windows.Rect]::new(0, 0, 64, 64), 14, 14)
    $glyph = [Windows.Media.FormattedText]::new([string][char]0xE75C, [Globalization.CultureInfo]::InvariantCulture, 'LeftToRight',
        [Windows.Media.Typeface]::new('Segoe Fluent Icons, Segoe MDL2 Assets'), 34, (Get-Brush 'OnAccent'), 1.0)
    $dc.DrawText($glyph, [Windows.Point]::new((64 - $glyph.Width) / 2, (64 - $glyph.Height) / 2))
    $dc.Close()
    $bmp = [Windows.Media.Imaging.RenderTargetBitmap]::new(64, 64, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bmp.Render($visual)
    $bmp
}

function Save-Snapshot([string]$Path) {
    $window.UpdateLayout()
    $root = $window.Content
    $bmp = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$root.ActualWidth, [int]$root.ActualHeight, 96, 96,
        [Windows.Media.PixelFormats]::Pbgra32)
    $bmp.Render($root)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
    $stream = [IO.File]::Create($Path)
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
}
#endregion

#region Wiring ------------------------------------------------------------------
# Polls the running job (scan task or background clean) without blocking the UI thread.
$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$timer.add_Tick({
    $job = $script:Job
    if (-not $job) { $timer.Stop(); return }
    $ui.PhaseText.Text = $job.Sync.Phase
    $ui.ProgressText.Text = '{0:N0} files checked' -f [DiskCleaner.Engine]::Processed
    $done = if ($job.Task) { $job.Task.IsCompleted } else { $job.Handle.IsCompleted }
    if (-not $done) { return }
    $timer.Stop()
    $script:Job = $null
    try { & $job.OnDone $job } finally { Set-Busy $false $false }
    if ($script:PendingScan) {
        $pending = $script:PendingScan
        $script:PendingScan = $null
        if ($pending -is [string]) { Start-Scan } else { Start-Scan $pending }
    }
})

# Re-scan shortly after the age filter stops moving.
$ageDebounce = [Windows.Threading.DispatcherTimer]::new()
$ageDebounce.Interval = [TimeSpan]::FromMilliseconds(600)
$ageDebounce.add_Tick({ $ageDebounce.Stop(); Save-Settings; Start-Scan })

$ui.GroupList.ItemsSource = $groups

# Clicking anywhere on a row toggles it; buttons and checkboxes keep their own behavior.
$ui.GroupList.AddHandler([Windows.UIElement]::MouseLeftButtonUpEvent, [Windows.Input.MouseButtonEventHandler]{
    param($s, $e)
    $el = $e.OriginalSource
    $row = if ($el -is [Windows.FrameworkElement] -or $el -is [Windows.FrameworkContentElement]) { $el.DataContext } else { $null }
    if ($row -isnot [DiskCleaner.CategoryRow] -or -not $row.IsAvailable) { return }
    while ($el -and $el -ne $s) {
        if ($el -is [Windows.Controls.Primitives.ButtonBase]) { return }
        $el = if ($el -is [Windows.Media.Visual]) { [Windows.Media.VisualTreeHelper]::GetParent($el) } else { $null }
    }
    $row.IsSelected = -not $row.IsSelected
}, $true)

# Buttons inside the row/group templates.
$ui.GroupList.AddHandler([Windows.Controls.Primitives.ButtonBase]::ClickEvent, [Windows.RoutedEventHandler]{
    param($s, $e)
    $btn = $e.OriginalSource
    if ($btn -isnot [Windows.Controls.Button]) { return }
    switch ($btn.Tag) {
        'open'      { Open-RowFolder $btn.DataContext }
        'remove'    { Remove-CustomRow $btn.DataContext }
        'addfolder' { Add-CustomFolder }
    }
})

$ui.AgeSlider.add_ValueChanged({
    Update-AgeText
    if ($window.IsLoaded) { $ageDebounce.Stop(); $ageDebounce.Start() }
})
# Switching the option updates every custom folder and its "To Recycle Bin" chip.
foreach ($handler in 'add_Checked', 'add_Unchecked') {
    $ui.RecycleCustom.$handler({
        if (-not $window.IsLoaded) { return }
        foreach ($row in $groupByKey.Custom.Rows) {
            $catByName[$row.Name].Recycle = [bool]$ui.RecycleCustom.IsChecked
            if ($row.StatusKind -in '', 'info') { Set-RowStatus $row $(if ($ui.RecycleCustom.IsChecked) { 'to Recycle Bin' } else { '' }) }
        }
        Save-Settings
    })
}

foreach ($radio in $ui.DiskSsd, $ui.DiskHdd) {
    $radio.add_Checked({ Update-DiskHint; if ($window.IsLoaded) { Save-Settings } })
}

$ui.ScanButton.add_Click({ Start-Scan })
$ui.CleanButton.add_Click({ Show-Confirm })
$ui.CancelButton.add_Click({ [DiskCleaner.Engine]::Cancel(); $ui.PhaseText.Text = 'Cancelling...' })
$ui.DialogCancel.add_Click({ $script:PendingClean = $null; Hide-Confirm })
$ui.DialogConfirm.add_Click({ Start-Clean })
$ui.InfoClose.add_Click({ $ui.InfoBar.Visibility = 'Collapsed' })
$ui.LogButton.add_Click({ Set-LogVisible ($ui.LogPanel.Visibility -ne 'Visible') })

$ui.SelectRecommended.add_Click({ Set-Selection { param($r) $r.Group -eq 'Core' } })
$ui.SelectAll.add_Click({ Set-Selection { param($r) $true } })
$ui.SelectNone.add_Click({ Set-Selection { param($r) $false } })

$ui.ElevateButton.add_Click({
    Save-Settings
    try {
        if ($DiskCleanerExe) { Start-Process $DiskCleanerExe -Verb RunAs -ArgumentList "-Theme $Theme" }
        else { Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$SelfPath`" -Theme $Theme" }
        $window.Close()
    } catch {
        $ui.StatusText.Text = 'Elevation was cancelled.'
    }
})

$window.add_PreviewKeyDown({
    param($s, $e)
    if ($ui.Overlay.Visibility -eq 'Visible') {
        if ($e.Key -eq 'Escape') { $script:PendingClean = $null; Hide-Confirm; $e.Handled = $true }
        return
    }
    if ($e.Key -eq 'F5') { Start-Scan; $e.Handled = $true }
})

$window.add_Closing({
    param($s, $e)
    if ($script:Job) {
        $e.Cancel = $true
        Show-InfoBar 'info' 'Please wait for the current task to finish, or press Cancel first.'
        return
    }
    Save-Settings
})

# Windows 11: title bar follows the theme and blends with the window background.
$window.add_SourceInitialized({
    try {
        $hwnd = [Windows.Interop.WindowInteropHelper]::new($window).Handle
        $dark = [int]($ThemeName -eq 'Dark')
        [void][DiskCleaner.Native]::DwmSetWindowAttribute($hwnd, 20, [ref]$dark, 4)
        $c = (Get-Brush 'Bg').Color
        $colorRef = [int]$c.R -bor ([int]$c.G -shl 8) -bor ([int]$c.B -shl 16)
        [void][DiskCleaner.Native]::DwmSetWindowAttribute($hwnd, 35, [ref]$colorRef, 4)
    } catch { }
})

$window.add_ContentRendered({
    # Windows may open a slow-starting window behind the app in use; bring ours to the front once.
    if (-not $SnapshotPath) { $window.Topmost = $true; $window.Topmost = $false; [void]$window.Activate() }
    Start-Scan
})

# A failing handler must not take the whole window down.
$window.Dispatcher.add_UnhandledException({
    param($s, $e)
    $e.Handled = $true
    if ($SnapshotPath) { Write-Host "UI error: $($e.Exception.Message)"; $window.Close(); return }
    Write-Log "Unexpected error: $($e.Exception.Message)"
    Show-InfoBar 'error' "Something went wrong: $($e.Exception.Message)"
})
#endregion

#region Start -------------------------------------------------------------------
$settings = Read-Settings
if ($settings) { $script:SavedSelection = @($settings.Selected) }
foreach ($c in Get-CleanerCategory) {
    $selected = if ($settings) { $c.Name -in $script:SavedSelection } else { $c.Group -eq 'Core' }
    [void](Add-Row $c $selected)
}
$ui.RecycleCustom.IsChecked = -not ($settings -and $settings.PSObject.Properties['CustomToRecycleBin'] -and -not $settings.CustomToRecycleBin)
if ($settings) {
    foreach ($path in @($settings.CustomFolders)) {
        if (-not $path -or -not (Test-CustomRoot $path)) { continue }
        $cat = New-CustomCategory $path
        [void](Add-Row $cat ($cat.Name -in $script:SavedSelection))
    }
}

$ui.AgeSlider.Value = if ($settings -and $null -ne $settings.MinAgeDays) { [int]$settings.MinAgeDays } else { 1 }
$hdd = $settings -and ($settings.DiskType -eq 'HDD' -or ($settings.Threads -and $settings.Threads -le 2))
if ($hdd) { $ui.DiskHdd.IsChecked = $true } else { $ui.DiskSsd.IsChecked = $true }
Update-AgeText
Update-DiskHint

if ($isAdmin) {
    $ui.AdminText.Text = 'Administrator'
    $ui.AdminChip.Background = Get-Brush 'SuccessBg'
    $ui.AdminText.Foreground = Get-Brush 'SuccessText'
    $ui.AdminIcon.Foreground = Get-Brush 'SuccessText'
    # Removed rather than collapsed: collapsed controls still show up for screen readers.
    [void]$ui.ElevateButton.Parent.Children.Remove($ui.ElevateButton)
} else {
    $ui.AdminText.Text = 'Standard user'
    $ui.AdminChip.Background = Get-Brush 'WarningBg'
    $ui.AdminText.Foreground = Get-Brush 'WarningText'
    $ui.AdminIcon.Foreground = Get-Brush 'WarningText'
}

try { $window.Icon = New-AppIcon } catch { }
Update-Drives
Update-Hints
Update-Summary
Write-Log "Ready. Theme: $ThemeName, admin: $isAdmin, threads: $(Get-Threads), settings: $SettingsFile"

if ($SnapshotPath) {
    $window.WindowStartupLocation = 'Manual'
    $window.Left = -20000
    $window.ShowInTaskbar = $false
    $window.Height = 1700 # tall enough to show every group in one image
    $script:AfterFirstScan = { Save-Snapshot $SnapshotPath; $window.Close() }
}
[void]$window.ShowDialog()
#endregion
} catch {
    if (-not $SnapshotPath) {
        [void][Windows.MessageBox]::Show("Disk Cleaner could not start:`n`n$($_.Exception.Message)", 'Disk Cleaner', 'OK', 'Error')
    }
    throw
}
